#define NOMINMAX
#include <windows.h>
#include <objidl.h>
#include <shobjidl_core.h>
#include <thumbcache.h>
#include <wincodec.h>

#include <algorithm>
#include <cstdint>
#include <cwchar>
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
  if (FAILED(result)) preview->clear();
  return result;
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
    return ReadEmbeddedPreview(stream, &preview_);
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
