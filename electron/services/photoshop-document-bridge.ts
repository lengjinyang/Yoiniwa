import { spawn } from 'node:child_process';

type PhotoshopDocumentStatus = 'completed' | 'not-running' | 'no-document' | 'automation-error' | 'unsupported' | 'blocked';

export interface PhotoshopDocumentBridgeResult {
  ok: boolean;
  status: PhotoshopDocumentStatus;
  message?: string;
  document?: {
    documentName: string;
    width: number;
    height: number;
    colorMode: string;
    bitDepth: number;
    layerCount: number;
    format: 'psd' | 'psb';
    archivePath: string;
    previewPath: string;
  };
  documentInfo?: { documentName: string };
}

type PhotoshopDocumentRequest =
  | { kind: 'place-raster'; imagePath: string; name: string; pixelWidth?: number; pixelHeight?: number }
  | { kind: 'place-raster-batch'; images: Array<{ imagePath: string; name: string; pixelWidth?: number; pixelHeight?: number }> }
  | { kind: 'open-image'; imagePath: string; name: string }
  | { kind: 'document-info' }
  | { kind: 'capture-version'; archivePsdPath: string; archivePsbPath: string; previewPath: string }
  | { kind: 'open-version'; versionPath: string; name: string };

const bridgeScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
function Result([bool]$ok, [string]$status, [string]$message, $document = $null, $documentInfo = $null) {
  @{ ok = $ok; status = $status; message = $message; document = $document; documentInfo = $documentInfo } | ConvertTo-Json -Compress -Depth 6
}
function Js([string]$value) {
  if ($null -eq $value) { return '""' }
  return '"' + $value.Replace('\', '\\').Replace('"', '\"').Replace([string][char]13, '').Replace([string][char]10, '\n') + '"'
}
try {
  $encoded = [Console]::In.ReadToEnd().Trim()
  $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded))
  $request = $json | ConvertFrom-Json
  try { $photoshop = [Runtime.InteropServices.Marshal]::GetActiveObject('Photoshop.Application') }
  catch { Result $false 'not-running' 'Photoshop 未运行'; exit 0 }
  if ($request.kind -in @('place-raster', 'place-raster-batch', 'capture-version', 'document-info') -and $photoshop.Documents.Count -lt 1) {
    Result $false 'no-document' 'Photoshop 没有可用的活动文档'; exit 0
  }
  if ($request.kind -eq 'document-info') {
    $documentName = [string]$photoshop.DoJavaScript('app.activeDocument.name')
    if (-not $documentName) { Result $false 'automation-error' '无法读取 Photoshop 当前文档名称'; exit 0 }
    Result $true 'completed' '已读取 Photoshop 当前文档' $null @{ documentName = $documentName }; exit 0
  }
  if ($request.kind -eq 'place-raster-batch') {
    $operations = @(); foreach ($entry in @($request.images)) {
      $entryPath = Js ([string]$entry.imagePath); $entryName = Js ([string]$entry.name)
      $entryWidth = [Math]::Max(0, [int]$entry.pixelWidth); $entryHeight = [Math]::Max(0, [int]$entry.pixelHeight)
      $operations += "placeSmartObject($entryPath,$entryName,$entryWidth,$entryHeight);"
    }
    if ($operations.Count -lt 1) { Result $false 'automation-error' '没有可发送到 Photoshop 的图片'; exit 0 }
    $operationText = $operations -join [Environment]::NewLine
    $jsx = @"
var target=app.activeDocument;
var previousUnits=app.preferences.rulerUnits;
function placeSmartObject(file,name,desiredWidth,desiredHeight){
  var descriptor=new ActionDescriptor();
  descriptor.putPath(charIDToTypeID('null'),new File(file));
  descriptor.putEnumerated(charIDToTypeID('FTcs'),charIDToTypeID('QCSt'),charIDToTypeID('Qcsa'));
  var offset=new ActionDescriptor();
  offset.putUnitDouble(charIDToTypeID('Hrzn'),charIDToTypeID('#Pxl'),0);
  offset.putUnitDouble(charIDToTypeID('Vrtc'),charIDToTypeID('#Pxl'),0);
  descriptor.putObject(charIDToTypeID('Ofst'),charIDToTypeID('Ofst'),offset);
  executeAction(charIDToTypeID('Plc '),descriptor,DialogModes.NO);
  var layer=target.activeLayer;
  layer.name=name;
  var b=layer.bounds;
  var placedWidth=b[2].as('px')-b[0].as('px'),placedHeight=b[3].as('px')-b[1].as('px');
  var rawScale=(desiredWidth>0&&desiredHeight>0&&placedWidth>0&&placedHeight>0)
    ? Math.min(desiredWidth/placedWidth,desiredHeight/placedHeight) : 1;
  var fitWidth=placedWidth*rawScale,fitHeight=placedHeight*rawScale;
  var fitScale=Math.min(1,target.width.as('px')*.82/Math.max(1,fitWidth),target.height.as('px')*.82/Math.max(1,fitHeight));
  var totalScale=rawScale*fitScale;
  if(Math.abs(totalScale-1)>0.001) layer.resize(totalScale*100,totalScale*100,AnchorPosition.MIDDLECENTER);
  b=layer.bounds;
  var dx=(target.width.as('px')-b[0].as('px')-b[2].as('px'))/2;
  var dy=(target.height.as('px')-b[1].as('px')-b[3].as('px'))/2;
  layer.translate(UnitValue(dx,'px'),UnitValue(dy,'px'));
}
function placeAllSmartObjects(){
$operationText
}
try{
  app.preferences.rulerUnits=Units.PIXELS;
  target.suspendHistory('Yoiniwa 传输','placeAllSmartObjects()');
}finally{
  try{app.activeDocument=target;}catch(activateError){}
  try{app.preferences.rulerUnits=previousUnits;}catch(unitsError){}
}
"@
    $null = $photoshop.DoJavaScript($jsx)
    Result $true 'completed' '已发送为 Photoshop 智能对象图层'; exit 0
  }
  if ($request.kind -eq 'place-raster') {
    $path = Js ([string]$request.imagePath); $name = Js ([string]$request.name)
    $pixelWidth = [Math]::Max(0, [int]$request.pixelWidth); $pixelHeight = [Math]::Max(0, [int]$request.pixelHeight)
    $jsx = @"
var target=app.activeDocument;
var previousUnits=app.preferences.rulerUnits;
var desiredWidth=$pixelWidth,desiredHeight=$pixelHeight;
try{
  app.preferences.rulerUnits=Units.PIXELS;
  var descriptor=new ActionDescriptor();
  descriptor.putPath(charIDToTypeID('null'),new File($path));
  descriptor.putEnumerated(charIDToTypeID('FTcs'),charIDToTypeID('QCSt'),charIDToTypeID('Qcsa'));
  var offset=new ActionDescriptor();
  offset.putUnitDouble(charIDToTypeID('Hrzn'),charIDToTypeID('#Pxl'),0);
  offset.putUnitDouble(charIDToTypeID('Vrtc'),charIDToTypeID('#Pxl'),0);
  descriptor.putObject(charIDToTypeID('Ofst'),charIDToTypeID('Ofst'),offset);
  executeAction(charIDToTypeID('Plc '),descriptor,DialogModes.NO);
  var layer=target.activeLayer;
  target.activeLayer=layer;
  layer.name=$name;
  var b=layer.bounds;
  var placedWidth=b[2].as('px')-b[0].as('px');
  var placedHeight=b[3].as('px')-b[1].as('px');
  if(desiredWidth>0&&desiredHeight>0&&placedWidth>0&&placedHeight>0){
    var rawScale=Math.min(desiredWidth/placedWidth,desiredHeight/placedHeight);
    layer.resize(rawScale*100,rawScale*100,AnchorPosition.MIDDLECENTER);
    b=layer.bounds;
  }
  placedWidth=b[2].as('px')-b[0].as('px');
  placedHeight=b[3].as('px')-b[1].as('px');
  var fitScale=Math.min(1,target.width.as('px')*.82/placedWidth,target.height.as('px')*.82/placedHeight);
  if(fitScale<1){layer.resize(fitScale*100,fitScale*100,AnchorPosition.MIDDLECENTER);b=layer.bounds;}
  var dx=(target.width.as('px')-b[0].as('px')-b[2].as('px'))/2;
  var dy=(target.height.as('px')-b[1].as('px')-b[3].as('px'))/2;
  layer.translate(UnitValue(dx,'px'),UnitValue(dy,'px'));
}finally{
  try{app.activeDocument=target;}catch(activateError){}
  try{app.preferences.rulerUnits=previousUnits;}catch(unitsError){}
}
"@
    $null = $photoshop.DoJavaScript($jsx)
    Result $true 'completed' '已发送为 Photoshop 智能对象'; exit 0
  }
  if ($request.kind -eq 'open-image') {
    $path = Js ([string]$request.imagePath); $name = Js ([string]$request.name)
    $jsx = "var source=null,target=null;try{source=app.open(new File($path));target=source.duplicate($name,false);}finally{if(source){try{app.activeDocument=source;source.close(SaveOptions.DONOTSAVECHANGES);}catch(e){}}if(target){app.activeDocument=target;}}"
    $null = $photoshop.DoJavaScript($jsx)
    Result $true 'completed' '已在 Photoshop 中打开新图像'; exit 0
  }
  if ($request.kind -eq 'open-version') {
    $path = Js ([string]$request.versionPath); $name = Js ([string]$request.name)
    $jsx = "var source=null,target=null;try{source=app.open(new File($path));target=source.duplicate($name,false);}finally{if(source){try{app.activeDocument=source;source.close(SaveOptions.DONOTSAVECHANGES);}catch(e){}}if(target){app.activeDocument=target;}}"
    $null = $photoshop.DoJavaScript($jsx)
    Result $true 'completed' '已在 Photoshop 中打开分层版本'; exit 0
  }
  if ($request.kind -eq 'capture-version') {
    $psd = Js ([string]$request.archivePsdPath); $psb = Js ([string]$request.archivePsbPath); $preview = Js ([string]$request.previewPath)
    $jsx = @"
function countLayers(container){var count=0;for(var i=0;i<container.layers.length;i++){count++;if(container.layers[i].typename==='LayerSet')count+=countLayers(container.layers[i]);}return count;}
function modeName(mode){try{return mode.toString().replace('DocumentMode.','');}catch(e){return 'UNKNOWN';}}
function jsonQuote(value){return '"'+String(value).replace(/\\/g,'\\\\').replace(/"/g,'\\"').replace(/\r/g,'\\r').replace(/\n/g,'\\n').replace(/\t/g,'\\t')+'"';}
var original=app.activeDocument;
var snapshot=null,preview=null,resultJson='';
try{
  snapshot=original.duplicate();
  var usePsb=original.width.as('px')>30000||original.height.as('px')>30000;
  var archivePath=$psd;
  if(!usePsb){try{snapshot.saveAs(new File($psd),new PhotoshopSaveOptions(),true,Extension.LOWERCASE);}catch(e){usePsb=true;}}
  if(usePsb){archivePath=$psb;snapshot.saveAs(new File($psb),new LargeDocumentFormatSaveOptions(),true,Extension.LOWERCASE);}
  preview=snapshot.duplicate();
  preview.flatten();
  try{if(preview.mode!==DocumentMode.RGB)preview.changeMode(ChangeMode.RGB);}catch(e){}
  try{preview.bitsPerChannel=BitsPerChannelType.EIGHT;}catch(e){}
  try{preview.convertProfile('sRGB IEC61966-2.1',Intent.PERCEPTUAL,true,false);}catch(e){}
  var previewWidth=preview.width.as('px'),previewHeight=preview.height.as('px');
  var previewScale=Math.min(1,2048/Math.max(previewWidth,previewHeight));
  if(previewScale<1){preview.resizeImage(UnitValue(Math.max(1,Math.round(previewWidth*previewScale)),'px'),UnitValue(Math.max(1,Math.round(previewHeight*previewScale)),'px'),null,ResampleMethod.BICUBICSHARPER);}
  preview.saveAs(new File($preview),new PNGSaveOptions(),true,Extension.LOWERCASE);
  var width=Math.round(original.width.as('px')),height=Math.round(original.height.as('px'));
  var bitDepth=Number(original.bitsPerChannel.toString().replace(/[^0-9]/g,''))||8;
  resultJson='{'+
    '"documentName":'+jsonQuote(original.name)+','+
    '"width":'+width+',"height":'+height+','+
    '"colorMode":'+jsonQuote(modeName(original.mode))+','+
    '"bitDepth":'+bitDepth+',"layerCount":'+countLayers(original)+','+
    '"format":'+jsonQuote(usePsb?'psb':'psd')+','+
    '"archivePath":'+jsonQuote(archivePath)+','+
    '"previewPath":'+jsonQuote($preview)+'}';
}finally{
  if(preview){try{preview.close(SaveOptions.DONOTSAVECHANGES);}catch(previewCloseError){}}
  if(snapshot){try{snapshot.close(SaveOptions.DONOTSAVECHANGES);}catch(snapshotCloseError){}}
  try{app.activeDocument=original;}catch(activateError){}
}
resultJson;
"@
    $raw = [string]$photoshop.DoJavaScript($jsx)
    $document = $raw | ConvertFrom-Json
    Result $true 'completed' 'Photoshop 版本已捕获' $document; exit 0
  }
  Result $false 'automation-error' '未知 Photoshop 文档操作'
} catch {
  Result $false 'automation-error' ([string]$_.Exception.Message)
}
`;

export function parsePhotoshopDocumentBridgeResponse(output: string): PhotoshopDocumentBridgeResult {
  const line = output.trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!line) return { ok: false, status: 'automation-error', message: 'Photoshop 文档桥没有返回结果' };
  try {
    const value = JSON.parse(line) as PhotoshopDocumentBridgeResult;
    if (typeof value.ok !== 'boolean' || !['completed', 'not-running', 'no-document', 'automation-error'].includes(value.status)) throw new Error();
    return value;
  } catch { return { ok: false, status: 'automation-error', message: 'Photoshop 文档桥返回了无效结果' }; }
}

export class PhotoshopDocumentBridge {
  private transition = Promise.resolve<unknown>(undefined);

  run(request: PhotoshopDocumentRequest, timeoutMs = request.kind === 'capture-version' ? 120_000 : 15_000) {
    const operation = this.transition.then(() => this.execute(request, timeoutMs));
    this.transition = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private execute(request: PhotoshopDocumentRequest, timeoutMs: number): Promise<PhotoshopDocumentBridgeResult> {
    if (process.platform !== 'win32') return Promise.resolve({ ok: false, status: 'unsupported', message: '当前平台不支持 Photoshop 文档桥' });
    return new Promise((resolve) => {
      const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', bridgeScript], {
        windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = ''; let settled = false;
      const finish = (result: PhotoshopDocumentBridgeResult) => {
        if (settled) return;
        settled = true; clearTimeout(timer); resolve(result);
      };
      child.stdout.setEncoding('utf8'); child.stdout.on('data', (chunk: string) => { stdout += chunk; });
      child.stderr.resume();
      child.on('error', () => finish({ ok: false, status: 'automation-error', message: '无法启动 Photoshop 文档桥' }));
      child.on('exit', () => finish(parsePhotoshopDocumentBridgeResponse(stdout)));
      const timer = setTimeout(() => {
        child.kill(); finish({ ok: false, status: 'automation-error', message: 'Photoshop 文档操作超时' });
      }, timeoutMs);
      timer.unref?.();
      child.stdin.end(Buffer.from(JSON.stringify(request), 'utf8').toString('base64'));
    });
  }
}
