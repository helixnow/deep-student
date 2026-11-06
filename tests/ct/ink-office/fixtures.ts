import JSZip from 'jszip';

export const DOCX_MARKER_COLORS = ['#d7191c', '#1450cc'] as const;
export const PPTX_MARKER_COLORS = ['#16852b', '#e9a400'] as const;
export const PPTX_SECOND_MARKER_COLORS = ['#00a6a6', '#d44a9f'] as const;

export interface OfficeFixtureOptions {
  includeChart?: boolean;
  includeSecondImage?: boolean;
  externalImage?: boolean;
}

async function markerPng(color: string): Promise<ArrayBuffer> {
  const canvas = document.createElement('canvas');
  canvas.width = 120;
  canvas.height = 30;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas unavailable for Office fixture');
  context.fillStyle = color;
  context.fillRect(0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((value) => value ? resolve(value) : reject(new Error('PNG encoding failed')), 'image/png');
  });
  return blob.arrayBuffer();
}

const docxImage = (index: number) => `<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="1143000" cy="285750"/><wp:docPr id="${index}" name="Page marker ${index}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${index}" name="marker${index}.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdImage${index}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1143000" cy="285750"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;

function docxPage(index: number): string {
  const label = index === 1 ? 'DOCX FIRST PAGE ORDER MARKER' : 'DOCX SECOND PAGE ORDER MARKER';
  const table = index === 1
    ? '<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="2400"/><w:gridCol w:w="2400"/></w:tblGrid><w:tr><w:tc><w:p><w:r><w:t>Fixture table</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>First page</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
    : '';
  const spacers = Array.from({ length: 40 }, () => '<w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="exact"/></w:pPr><w:r><w:t xml:space="preserve"> </w:t></w:r></w:p>').join('');
  const pageBreak = index === 1 ? '<w:p><w:r><w:br w:type="page"/></w:r></w:p>' : '';
  return `<w:p><w:r><w:t>${label}</w:t></w:r></w:p>${table}${spacers}${docxImage(index)}${pageBreak}`;
}

async function makeDocx(): Promise<ArrayBuffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${docxPage(1)}${docxPage(2)}<w:sectPr><w:pgSz w:w="10000" w:h="14000"/><w:pgMar w:top="600" w:right="600" w:bottom="600" w:left="600" w:header="300" w:footer="300" w:gutter="0"/></w:sectPr></w:body></w:document>`);
  zip.file('word/_rels/document.xml.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdImage1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/marker1.png"/><Relationship Id="rIdImage2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/marker2.png"/></Relationships>');
  for (let i = 1; i <= 2; i += 1) zip.file(`word/media/marker${i}.png`, await markerPng(DOCX_MARKER_COLORS[i - 1]));
  return zip.generateAsync({ type: 'arraybuffer' });
}

const pptxShape = (label: string) => `<p:sp><p:nvSpPr><p:cNvPr id="2" name="${label}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="228600"/><a:ext cx="5000000" cy="600000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>${label}</a:t></a:r><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>`;
function pptxImage(id: number, y: number): string {
  return `<p:pic><p:nvPicPr><p:cNvPr id="${id + 2}" name="Slide marker ${id}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rIdImage${id}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="457200" y="${y}"/><a:ext cx="1828800" cy="457200"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
}

const pptxChart = '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="20" name="Fixture chart"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="5200000" y="1400000"/><a:ext cx="3000000" cy="2200000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rIdChart"/></a:graphicData></a:graphic></p:graphicFrame>';

function pptxSlide(index: number, imageCount: number, includeChart: boolean): string {
  const label = index === 1 ? 'PPTX FIRST SLIDE ORDER MARKER' : 'PPTX SECOND SLIDE ORDER MARKER';
  const imageMarkup = Array.from({ length: imageCount }, (_, imageIndex) => pptxImage(imageIndex + 1, imageCount === 1 ? 4300000 : 2300000 + imageIndex * 1200000)).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld name="${label}"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${pptxShape(label)}${imageMarkup}${includeChart ? pptxChart : ''}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

async function makePptx(options: OfficeFixtureOptions = {}): Promise<ArrayBuffer> {
  const zip = new JSZip();
  const imageCount = options.includeSecondImage || options.externalImage ? 2 : 1;
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/><Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>${options.includeChart ? '<Override PartName="/ppt/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>' : ''}</Types>`);
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>');
  zip.file('ppt/presentation.xml', '<?xml version="1.0" encoding="UTF-8"?><p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rIdMaster"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rIdSlide1"/><p:sldId id="257" r:id="rIdSlide2"/></p:sldIdLst><p:sldSz cx="9144000" cy="5143500" type="wide"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle/></p:presentation>');
  zip.file('ppt/_rels/presentation.xml.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdMaster" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/><Relationship Id="rIdSlide1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/><Relationship Id="rIdSlide2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/></Relationships>');
  zip.file('ppt/slideMasters/slideMaster1.xml', '<?xml version="1.0" encoding="UTF-8"?><p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld name="Master"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="1" r:id="rIdLayout"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>');
  zip.file('ppt/slideMasters/_rels/slideMaster1.xml.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdLayout" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rIdTheme" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>');
  zip.file('ppt/slideLayouts/slideLayout1.xml', '<?xml version="1.0" encoding="UTF-8"?><p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1"><p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>');
  zip.file('ppt/slideLayouts/_rels/slideLayout1.xml.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdMaster" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>');
  zip.file('ppt/theme/theme1.xml', '<?xml version="1.0" encoding="UTF-8"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Fixture"><a:themeElements><a:clrScheme name="Fixture"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="404040"/></a:dk2><a:lt2><a:srgbClr val="EEEEEE"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Fixture"><a:majorFont><a:latin typeface="Arial"/></a:majorFont><a:minorFont><a:latin typeface="Arial"/></a:minorFont></a:fontScheme><a:fmtScheme name="Fixture"><a:fillStyleLst/><a:lnStyleLst/><a:effectStyleLst/><a:bgFillStyleLst/></a:fmtScheme></a:themeElements></a:theme>');
  if (options.includeChart) {
    zip.file('ppt/charts/chart1.xml', '<?xml version="1.0" encoding="UTF-8"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart><c:plotArea><c:layout/><c:lineChart><c:grouping val="standard"/><c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:v>Fixture series</c:v></c:tx><c:cat><c:strRef><c:f>Sheet1!$A$2:$A$3</c:f><c:strCache><c:ptCount val="2"/><c:pt idx="0"><c:v>First</c:v></c:pt><c:pt idx="1"><c:v>Second</c:v></c:pt></c:strCache></c:strRef></c:cat><c:val><c:numRef><c:f>Sheet1!$B$2:$B$3</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="2"/><c:pt idx="0"><c:v>1</c:v></c:pt><c:pt idx="1"><c:v>2</c:v></c:pt></c:numCache></c:numRef></c:val><c:spPr><a:ln xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:solidFill><a:srgbClr val="16852B"/></a:solidFill></a:ln></c:spPr></c:ser><c:axId val="1"/><c:axId val="2"/></c:lineChart><c:catAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="b"/><c:crossAx val="2"/><c:crosses val="autoZero"/></c:catAx><c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="l"/><c:crossAx val="1"/><c:crosses val="autoZero"/></c:valAx></c:plotArea><c:plotVisOnly val="1"/></c:chart></c:chartSpace>');
  }
  for (let i = 1; i <= 2; i += 1) {
    const rels = ['<Relationship Id="rIdLayout" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>'];
    for (let imageIndex = 1; imageIndex <= imageCount; imageIndex += 1) {
      const id = `rIdImage${imageIndex}`;
      const isExternalImage = options.externalImage && i === 1 && imageIndex === 1;
      const target = isExternalImage ? 'https://example.invalid/must-not-fetch.png' : `../media/marker${i}-${imageIndex}.png`;
      rels.push(`<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${target}"${isExternalImage ? ' TargetMode="External"' : ''}/>`);
      if (!isExternalImage) {
        const color = imageIndex === 1 ? PPTX_MARKER_COLORS[i - 1] : PPTX_SECOND_MARKER_COLORS[i - 1];
        zip.file(`ppt/media/marker${i}-${imageIndex}.png`, await markerPng(color));
      }
    }
    if (options.includeChart && i === 1) {
      rels.push('<Relationship Id="rIdChart" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/>');
    }
    if (options.externalRelationship && i === 1) {
      rels.push('<Relationship Id="rIdExternal" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.invalid/must-not-fetch" TargetMode="External"/>');
    }
    zip.file(`ppt/slides/slide${i}.xml`, pptxSlide(i, imageCount, options.includeChart === true && i === 1));
    zip.file(`ppt/slides/_rels/slide${i}.xml.rels`, `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`);
  }
  return zip.generateAsync({ type: 'arraybuffer' });
}

export function makeOfficeFixture(format: 'docx' | 'pptx', options: OfficeFixtureOptions = {}): Promise<ArrayBuffer> {
  return format === 'docx' ? makeDocx() : makePptx(options);
}

export const OFFICE_FIXTURE_MAX_ENTRIES = 10_000;
export const OFFICE_FIXTURE_MAX_ENTRY_BYTES = 32 * 1024 * 1024;
export const OFFICE_FIXTURE_MAX_TOTAL_BYTES = 128 * 1024 * 1024;
export type OfficeBudgetFixtureKind = 'entry-count' | 'entry-size' | 'total-size';

function patchDeclaredUncompressedSizes(zipBytes: Uint8Array, paths: string[], size: number): ArrayBuffer {
  const view = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  const decoder = new TextDecoder();
  const patched = new Map(paths.map((path) => [path, 0]));
  for (let offset = 0; offset + 46 < view.byteLength; offset += 1) {
    const signature = view.getUint32(offset, true);
    const local = signature === 0x04034b50;
    const central = signature === 0x02014b50;
    if (!local && !central) continue;
    const nameLength = view.getUint16(offset + (local ? 26 : 28), true);
    const nameStart = offset + (local ? 30 : 46);
    if (nameStart + nameLength > view.byteLength) continue;
    const name = decoder.decode(zipBytes.subarray(nameStart, nameStart + nameLength));
    if (!patched.has(name)) continue;
    view.setUint32(offset + (local ? 22 : 24), size, true);
    patched.set(name, patched.get(name)! + 1);
  }
  if ([...patched.values()].some((count) => count < 2)) throw new Error('Unable to construct compressed ZIP budget fixture');
  const output = new ArrayBuffer(zipBytes.byteLength);
  new Uint8Array(output).set(zipBytes);
  return output;
}

export async function makeOfficeBudgetFixture(kind: OfficeBudgetFixtureKind): Promise<ArrayBuffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Budget fixture</w:t></w:r></w:p><w:sectPr/></w:body></w:document>');

  if (kind === 'entry-count') {
    for (let index = 0; index <= OFFICE_FIXTURE_MAX_ENTRIES; index += 1) zip.file(`customXml/item${index}.xml`, '<item/>');
    return zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' });
  }

  const paths = kind === 'entry-size'
    ? ['customXml/large.xml']
    : Array.from({ length: 5 }, (_, index) => `customXml/aggregate${index}.xml`);
  for (const path of paths) zip.file(path, '<item>' + 'compressed budget fixture '.repeat(256) + '</item>');
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  const declaredSize = kind === 'entry-size' ? OFFICE_FIXTURE_MAX_ENTRY_BYTES + 1 : OFFICE_FIXTURE_MAX_ENTRY_BYTES;
  const forgedZip = patchDeclaredUncompressedSizes(bytes, paths, declaredSize);
  if (forgedZip.byteLength >= declaredSize) throw new Error('ZIP budget fixture is not compressed');
  return forgedZip;
}

export function makeOfficeRefusalFixture(kind: 'malformed' | 'legacy' | 'encrypted'): ArrayBuffer {
  if (kind === 'malformed') return new TextEncoder().encode('not an Office package').buffer;
  return new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]).buffer;
}
