#define NOMINMAX
#include <windows.h>
#include <objidl.h>
#include <shobjidl_core.h>
#include <thumbcache.h>
#include <wincodec.h>

#include <algorithm>
#include <cstdint>
#include <cwchar>
#include <cstring>
#include <new>
#include <string>
#include <vector>

#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "gdi32.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "user32.lib")
#pragma comment(lib, "windowscodecs.lib")

// {2B0F173D-5E7E-4C36-A901-9A9D75E2B7BF}
const CLSID CLSID_YoiniwaThumbnailProvider = {
  0x2b0f173d, 0x5e7e, 0x4c36, { 0xa9, 0x01, 0x9a, 0x9d, 0x75, 0xe2, 0xb7, 0xbf },
};

namespace {
constexpr wchar_t kClsid[] = L"{2B0F173D-5E7E-4C36-A901-9A9D75E2B7BF}";
constexpr wchar_t kClsidKey[] = L"CLSID\\{2B0F173D-5E7E-4C36-A901-9A9D75E2B7BF}";
constexpr char kPreviewEntry[] = "preview.png";
constexpr uint32_t kLocalHeaderSignature = 0x04034b50;
constexpr size_t kMaximumPreviewBytes = 4 * 1024 * 1024;
constexpr size_t kYoiHeaderBytes = 8192;
constexpr size_t kYoiSuperblockBytes = 256;
constexpr size_t kYoiSegmentHeaderBytes = 96;
constexpr uint64_t kYoiSuperblockOffsets[] = { 512, 768 };
constexpr char kYoiMagic[] = "YOINIWA\0";
constexpr char kYoiSlotMagic[] = "YOISLOT\0";
constexpr char kYoiSegmentMagic[] = "YOISEG4\0";
HMODULE moduleInstance = nullptr;
LONG activeObjects = 0;

uint16_t ReadU16(const uint8_t* value) {
  return static_cast<uint16_t>(value[0]) | (static_cast<uint16_t>(value[1]) << 8);
}

uint32_t ReadU32(const uint8_t* value) {
  return static_cast<uint32_t>(value[0])
    | (static_cast<uint32_t>(value[1]) << 8)
    | (static_cast<uint32_t>(value[2]) << 16)
    | (static_cast<uint32_t>(value[3]) << 24);
}

uint64_t ReadU64(const uint8_t* value) {
  uint64_t result = 0;
  for (size_t index = 0; index < 8; ++index) result |= static_cast<uint64_t>(value[index]) << (index * 8);
  return result;
}

uint32_t Crc32(const uint8_t* value, size_t length) {
  uint32_t crc = 0xffffffff;
  for (size_t index = 0; index < length; ++index) {
    crc ^= value[index];
    for (int bit = 0; bit < 8; ++bit) crc = (crc >> 1) ^ (0xedb88320 & -(static_cast<int32_t>(crc & 1)));
  }
  return crc ^ 0xffffffff;
}

bool IsPng(const std::vector<uint8_t>& value) {
  constexpr uint8_t signature[] = { 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a };
  return value.size() >= sizeof(signature) && std::memcmp(value.data(), signature, sizeof(signature)) == 0;
}

HRESULT ReadExact(IStream* stream, void* destination, ULONG bytes) {
  auto* output = static_cast<uint8_t*>(destination);
  ULONG total = 0;
  while (total < bytes) {
    ULONG read = 0;
    const HRESULT result = stream->Read(output + total, bytes - total, &read);
    if (FAILED(result)) return result;
    if (read == 0) return STG_E_READFAULT;
    total += read;
  }
  return S_OK;
}

HRESULT ReadEmbeddedPreview(IStream* stream, std::vector<uint8_t>* preview) {
  LARGE_INTEGER start{};
  HRESULT result = stream->Seek(start, STREAM_SEEK_SET, nullptr);
  if (FAILED(result)) return result;

  uint8_t header[30];
  result = ReadExact(stream, header, sizeof(header));
  if (FAILED(result) || ReadU32(header) != kLocalHeaderSignature) return E_FAIL;

  const uint16_t flags = ReadU16(header + 6);
  const uint16_t compression = ReadU16(header + 8);
  const uint32_t compressedSize = ReadU32(header + 18);
  const uint32_t uncompressedSize = ReadU32(header + 22);
  const uint16_t nameLength = ReadU16(header + 26);
  const uint16_t extraLength = ReadU16(header + 28);
  if ((flags & 0x0008) != 0 || compression != 0 || nameLength != sizeof(kPreviewEntry) - 1
    || extraLength > 4096 || compressedSize != uncompressedSize || !compressedSize
    || compressedSize > kMaximumPreviewBytes) return E_FAIL;

  std::vector<char> name(nameLength);
  result = ReadExact(stream, name.data(), nameLength);
  if (FAILED(result) || std::string(name.begin(), name.end()) != kPreviewEntry) return E_FAIL;

  if (extraLength) {
    LARGE_INTEGER skip{};
    skip.QuadPart = extraLength;
    result = stream->Seek(skip, STREAM_SEEK_CUR, nullptr);
    if (FAILED(result)) return result;
  }

  preview->resize(compressedSize);
  result = ReadExact(stream, preview->data(), compressedSize);
  if (FAILED(result) || !IsPng(*preview)) { preview->clear(); return E_FAIL; }
  return result;
}

struct YoiSuperblock {
  uint64_t generation = 0;
  uint64_t snapshotOffset = 0;
  uint64_t snapshotLength = 0;
  uint64_t previewOffset = 0;
  uint64_t previewLength = 0;
  uint64_t endOffset = 0;
};

bool ValidYoiSuperblock(const uint8_t* value, uint64_t fileBytes, YoiSuperblock* output) {
  if (std::memcmp(value, kYoiSlotMagic, sizeof(kYoiSlotMagic) - 1) != 0
    || Crc32(value, 64) != ReadU32(value + 64)) return false;
  YoiSuperblock candidate;
  candidate.generation = ReadU64(value + 8);
  candidate.snapshotOffset = ReadU64(value + 16);
  candidate.snapshotLength = ReadU64(value + 24);
  candidate.previewOffset = ReadU64(value + 32);
  candidate.previewLength = ReadU64(value + 40);
  candidate.endOffset = ReadU64(value + 48);
  if (!candidate.generation || candidate.snapshotOffset < kYoiHeaderBytes + kYoiSegmentHeaderBytes
    || !candidate.snapshotLength || candidate.snapshotLength > 64ull * 1024 * 1024
    || candidate.endOffset > fileBytes || candidate.snapshotOffset > candidate.endOffset
    || candidate.snapshotLength > candidate.endOffset - candidate.snapshotOffset
    || candidate.previewLength > kMaximumPreviewBytes) return false;
  if (candidate.previewLength && (candidate.previewOffset < kYoiHeaderBytes + kYoiSegmentHeaderBytes
    || candidate.previewOffset > candidate.endOffset || candidate.previewLength > candidate.endOffset - candidate.previewOffset)) return false;
  *output = candidate;
  return true;
}

// Returns S_FALSE only when this is not a v4 YoiStorage file, so callers can
// fall back to the old ZIP-first-entry reader without scanning the file.
HRESULT ReadYoiStorageV4Preview(IStream* stream, std::vector<uint8_t>* preview) {
  LARGE_INTEGER start{};
  HRESULT result = stream->Seek(start, STREAM_SEEK_SET, nullptr);
  if (FAILED(result)) return result;
  std::vector<uint8_t> header(kYoiHeaderBytes);
  result = ReadExact(stream, header.data(), static_cast<ULONG>(header.size()));
  if (FAILED(result)) return S_FALSE;
  if (std::memcmp(header.data(), kYoiMagic, sizeof(kYoiMagic) - 1) != 0) return S_FALSE;
  if (ReadU32(header.data() + 8) != 4 || ReadU32(header.data() + 12) != kYoiHeaderBytes) return E_FAIL;

  STATSTG stat{};
  result = stream->Stat(&stat, STATFLAG_NONAME);
  if (FAILED(result) || stat.cbSize.QuadPart < kYoiHeaderBytes) return E_FAIL;
  const uint64_t fileBytes = static_cast<uint64_t>(stat.cbSize.QuadPart);
  bool found = false;
  YoiSuperblock selected;
  for (uint64_t offset : kYoiSuperblockOffsets) {
    YoiSuperblock candidate;
    const auto* slot = header.data() + offset;
    if (!ValidYoiSuperblock(slot, fileBytes, &candidate)) continue;
    if (!found || candidate.generation > selected.generation) { selected = candidate; found = true; }
  }
  if (!found || !selected.previewLength) return E_FAIL;

  const uint64_t segmentOffset = selected.previewOffset - kYoiSegmentHeaderBytes;
  if (segmentOffset > 0x7fffffffffffffffULL) return E_FAIL;
  LARGE_INTEGER seek{};
  seek.QuadPart = static_cast<LONGLONG>(segmentOffset);
  result = stream->Seek(seek, STREAM_SEEK_SET, nullptr);
  if (FAILED(result)) return result;
  uint8_t segment[kYoiSegmentHeaderBytes];
  result = ReadExact(stream, segment, sizeof(segment));
  if (FAILED(result) || std::memcmp(segment, kYoiSegmentMagic, sizeof(kYoiSegmentMagic) - 1) != 0
    || ReadU32(segment + 8) != 3 || ReadU32(segment + 12) != kYoiSegmentHeaderBytes
    || ReadU64(segment + 16) != selected.previewLength) return E_FAIL;

  preview->resize(static_cast<size_t>(selected.previewLength));
  result = ReadExact(stream, preview->data(), static_cast<ULONG>(preview->size()));
  if (FAILED(result) || !IsPng(*preview)) { preview->clear(); return E_FAIL; }
  return S_OK;
}

HRESULT ReadProjectPreview(IStream* stream, std::vector<uint8_t>* preview) {
  const HRESULT v4 = ReadYoiStorageV4Preview(stream, preview);
  if (v4 != S_FALSE) return v4;
  return ReadEmbeddedPreview(stream, preview);
}

template <typename T>
void Release(T*& value) {
  if (value) { value->Release(); value = nullptr; }
}

HRESULT CreateThumbnailBitmap(const std::vector<uint8_t>& png, UINT requestedSize, HBITMAP* bitmap) {
  if (!bitmap || png.empty()) return E_INVALIDARG;
  *bitmap = nullptr;

  HGLOBAL memory = GlobalAlloc(GMEM_MOVEABLE, png.size());
  if (!memory) return E_OUTOFMEMORY;
  IStream* pngStream = nullptr;
  HRESULT result = CreateStreamOnHGlobal(memory, TRUE, &pngStream);
  if (FAILED(result)) { GlobalFree(memory); return result; }
  memory = nullptr;

  ULONG written = 0;
  result = pngStream->Write(png.data(), static_cast<ULONG>(png.size()), &written);
  if (FAILED(result) || written != png.size()) { Release(pngStream); return STG_E_WRITEFAULT; }
  LARGE_INTEGER start{};
  result = pngStream->Seek(start, STREAM_SEEK_SET, nullptr);
  if (FAILED(result)) { Release(pngStream); return result; }

  IWICImagingFactory* factory = nullptr;
  IWICBitmapDecoder* decoder = nullptr;
  IWICBitmapFrameDecode* frame = nullptr;
  IWICBitmapScaler* scaler = nullptr;
  IWICFormatConverter* converter = nullptr;
  result = CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&factory));
  if (SUCCEEDED(result)) result = factory->CreateDecoderFromStream(pngStream, nullptr, WICDecodeMetadataCacheOnDemand, &decoder);
  if (SUCCEEDED(result)) result = decoder->GetFrame(0, &frame);

  UINT width = 0;
  UINT height = 0;
  if (SUCCEEDED(result)) result = frame->GetSize(&width, &height);
  if (SUCCEEDED(result) && (!width || !height || width > 1024 || height > 1024)) result = E_FAIL;

  const UINT limit = std::max<UINT>(1, requestedSize);
  const double ratio = SUCCEEDED(result) ? std::min(1.0, static_cast<double>(limit) / std::max(width, height)) : 1.0;
  const UINT targetWidth = std::max<UINT>(1, static_cast<UINT>(width * ratio + 0.5));
  const UINT targetHeight = std::max<UINT>(1, static_cast<UINT>(height * ratio + 0.5));
  if (SUCCEEDED(result)) result = factory->CreateBitmapScaler(&scaler);
  if (SUCCEEDED(result)) result = scaler->Initialize(frame, targetWidth, targetHeight, WICBitmapInterpolationModeFant);
  if (SUCCEEDED(result)) result = factory->CreateFormatConverter(&converter);
  if (SUCCEEDED(result)) result = converter->Initialize(scaler, GUID_WICPixelFormat32bppPBGRA, WICBitmapDitherTypeNone, nullptr, 0, WICBitmapPaletteTypeCustom);

  const size_t stride = static_cast<size_t>(targetWidth) * 4;
  const size_t bytes = stride * targetHeight;
  if (SUCCEEDED(result) && bytes > 16 * 1024 * 1024) result = E_FAIL;
  std::vector<uint8_t> pixels;
  if (SUCCEEDED(result)) {
    pixels.resize(bytes);
    result = converter->CopyPixels(nullptr, static_cast<UINT>(stride), static_cast<UINT>(bytes), pixels.data());
  }

  if (SUCCEEDED(result)) {
    BITMAPINFO info{};
    info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    info.bmiHeader.biWidth = static_cast<LONG>(targetWidth);
    info.bmiHeader.biHeight = -static_cast<LONG>(targetHeight);
    info.bmiHeader.biPlanes = 1;
    info.bmiHeader.biBitCount = 32;
    info.bmiHeader.biCompression = BI_RGB;
    void* target = nullptr;
    HDC screen = GetDC(nullptr);
    HBITMAP created = CreateDIBSection(screen, &info, DIB_RGB_COLORS, &target, nullptr, 0);
    ReleaseDC(nullptr, screen);
    if (!created || !target) result = E_OUTOFMEMORY;
    else { CopyMemory(target, pixels.data(), bytes); *bitmap = created; }
  }

  Release(converter);
  Release(scaler);
  Release(frame);
  Release(decoder);
  Release(factory);
  Release(pngStream);
  return result;
}

class ThumbnailProvider final : public IThumbnailProvider, public IInitializeWithStream {
 public:
  ThumbnailProvider() : references_(1) { InterlockedIncrement(&activeObjects); }

  STDMETHODIMP QueryInterface(REFIID iid, void** value) override {
    if (!value) return E_POINTER;
    *value = nullptr;
    if (iid == IID_IUnknown || iid == __uuidof(IThumbnailProvider)) *value = static_cast<IThumbnailProvider*>(this);
    else if (iid == __uuidof(IInitializeWithStream)) *value = static_cast<IInitializeWithStream*>(this);
    else return E_NOINTERFACE;
    AddRef();
    return S_OK;
  }

  STDMETHODIMP_(ULONG) AddRef() override { return InterlockedIncrement(&references_); }
  STDMETHODIMP_(ULONG) Release() override {
    const ULONG references = InterlockedDecrement(&references_);
    if (!references) delete this;
    return references;
  }

  STDMETHODIMP Initialize(IStream* stream, DWORD) override {
    if (!stream || initialized_) return initialized_ ? STG_E_ACCESSDENIED : E_INVALIDARG;
    initialized_ = true;
    return ReadProjectPreview(stream, &preview_);
  }

  STDMETHODIMP GetThumbnail(UINT size, HBITMAP* bitmap, WTS_ALPHATYPE* alphaType) override {
    if (!bitmap || !alphaType) return E_POINTER;
    const HRESULT result = CreateThumbnailBitmap(preview_, size, bitmap);
    if (SUCCEEDED(result)) *alphaType = WTSAT_ARGB;
    return result;
  }

 private:
  ~ThumbnailProvider() { InterlockedDecrement(&activeObjects); }
  LONG references_;
  bool initialized_ = false;
  std::vector<uint8_t> preview_;
};

class ClassFactory final : public IClassFactory {
 public:
  ClassFactory() : references_(1) { InterlockedIncrement(&activeObjects); }
  STDMETHODIMP QueryInterface(REFIID iid, void** value) override {
    if (!value) return E_POINTER;
    *value = nullptr;
    if (iid != IID_IUnknown && iid != IID_IClassFactory) return E_NOINTERFACE;
    *value = static_cast<IClassFactory*>(this);
    AddRef();
    return S_OK;
  }
  STDMETHODIMP_(ULONG) AddRef() override { return InterlockedIncrement(&references_); }
  STDMETHODIMP_(ULONG) Release() override {
    const ULONG references = InterlockedDecrement(&references_);
    if (!references) delete this;
    return references;
  }
  STDMETHODIMP CreateInstance(IUnknown* outer, REFIID iid, void** value) override {
    if (outer) return CLASS_E_NOAGGREGATION;
    auto* provider = new (std::nothrow) ThumbnailProvider();
    if (!provider) return E_OUTOFMEMORY;
    const HRESULT result = provider->QueryInterface(iid, value);
    provider->Release();
    return result;
  }
  STDMETHODIMP LockServer(BOOL lock) override {
    if (lock) InterlockedIncrement(&activeObjects);
    else InterlockedDecrement(&activeObjects);
    return S_OK;
  }
 private:
  ~ClassFactory() { InterlockedDecrement(&activeObjects); }
  LONG references_;
};

HRESULT SetRegistryString(const wchar_t* keyName, const wchar_t* valueName, const wchar_t* value) {
  HKEY key = nullptr;
  const LONG created = RegCreateKeyExW(HKEY_CLASSES_ROOT, keyName, 0, nullptr, REG_OPTION_NON_VOLATILE, KEY_WRITE, nullptr, &key, nullptr);
  if (created != ERROR_SUCCESS) return HRESULT_FROM_WIN32(created);
  const LONG written = RegSetValueExW(key, valueName, 0, REG_SZ, reinterpret_cast<const BYTE*>(value),
    static_cast<DWORD>((wcslen(value) + 1) * sizeof(wchar_t)));
  RegCloseKey(key);
  return written == ERROR_SUCCESS ? S_OK : HRESULT_FROM_WIN32(written);
}
}  // namespace

extern "C" BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, LPVOID) {
  if (reason == DLL_PROCESS_ATTACH) { moduleInstance = instance; DisableThreadLibraryCalls(instance); }
  return TRUE;
}

extern "C" HRESULT __stdcall DllCanUnloadNow() { return activeObjects == 0 ? S_OK : S_FALSE; }

extern "C" HRESULT __stdcall DllGetClassObject(REFCLSID clsid, REFIID iid, void** value) {
  if (clsid != CLSID_YoiniwaThumbnailProvider) return CLASS_E_CLASSNOTAVAILABLE;
  auto* factory = new (std::nothrow) ClassFactory();
  if (!factory) return E_OUTOFMEMORY;
  const HRESULT result = factory->QueryInterface(iid, value);
  factory->Release();
  return result;
}

extern "C" HRESULT __stdcall DllRegisterServer() {
  wchar_t modulePath[MAX_PATH];
  if (!GetModuleFileNameW(moduleInstance, modulePath, MAX_PATH)) return HRESULT_FROM_WIN32(GetLastError());
  HRESULT result = SetRegistryString(kClsidKey, nullptr, L"Yoiniwa Board Thumbnail Provider");
  if (SUCCEEDED(result)) {
    const std::wstring serverKey = std::wstring(kClsidKey) + L"\\InprocServer32";
    result = SetRegistryString(serverKey.c_str(), nullptr, modulePath);
    if (SUCCEEDED(result)) result = SetRegistryString(serverKey.c_str(), L"ThreadingModel", L"Apartment");
  }
  return result;
}

extern "C" HRESULT __stdcall DllUnregisterServer() {
  const LONG result = RegDeleteTreeW(HKEY_CLASSES_ROOT, kClsidKey);
  return result == ERROR_SUCCESS || result == ERROR_FILE_NOT_FOUND ? S_OK : HRESULT_FROM_WIN32(result);
}
