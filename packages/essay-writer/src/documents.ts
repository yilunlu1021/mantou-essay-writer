import { inflateRawSync } from 'node:zlib';
import { zipSync, strToU8 } from "fflate";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { documentSchema, type TextDocument } from "@mantou/text-quality";
import { fail, sha, utf8 } from "./files.js";
const MAX_XML = 2_000_000;
const escape = (s: string) => s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;').replaceAll('\r','&#13;');
const parser = new XMLParser({preserveOrder:true,ignoreAttributes:false,attributeNamePrefix:'@_',trimValues:false,parseTagValue:false,parseAttributeValue:false,processEntities:true});
type Xml = Array<Record<string, unknown>>;
function checkedXml(bytes: Uint8Array): Xml {
  const value = utf8(bytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(value) || XMLValidator.validate(value) !== true) fail("docx-xml", "The DOCX contains unsupported or invalid XML.");
  return parser.parse(value) as Xml;
}
function crc32(data: Uint8Array) {
  let crc=0xffffffff;
  for(const byte of data){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
  return (crc^0xffffffff)>>>0;
}
function unpack(data: Uint8Array) {
  if(data.length<22||data.length>5_000_000)fail('docx-archive','The DOCX file must be at most 5 MB.');
  const b=Buffer.from(data);const invalid=()=>fail('docx-archive','The DOCX archive is damaged, ambiguous or outside the supported limits.');
  let end=b.length-22;
  while(end>=Math.max(0,b.length-65557)&&(b.readUInt32LE(end)!==0x06054b50||end+22+b.readUInt16LE(end+20)!==b.length))end--;
  if(end<0||end<Math.max(0,b.length-65557))return invalid();
  const count=b.readUInt16LE(end+10),start=b.readUInt32LE(end+16),size=b.readUInt32LE(end+12);
  if(b.readUInt16LE(end+4)||b.readUInt16LE(end+6)||b.readUInt16LE(end+8)!==count||count>1000||start+size!==end||!count)return invalid();
  let cursor=start,total=0;const names=new Set<string>();const spans:Array<[number,number]>=[];const output:Record<string,Uint8Array>={};
  for(let i=0;i<count;i++){
    if(cursor+46>end||b.readUInt32LE(cursor)!==0x02014b50)return invalid();
    const flags=b.readUInt16LE(cursor+8),method=b.readUInt16LE(cursor+10),crc=b.readUInt32LE(cursor+16),compressed=b.readUInt32LE(cursor+20),original=b.readUInt32LE(cursor+24);
    const nl=b.readUInt16LE(cursor+28),el=b.readUInt16LE(cursor+30),cl=b.readUInt16LE(cursor+32),offset=b.readUInt32LE(cursor+42);
    const next=cursor+46+nl+el+cl;
    if(next>end||flags&1||![0,8].includes(method)||b.readUInt16LE(cursor+34)||offset+30>start)return invalid();
    const nameBytes=b.subarray(cursor+46,cursor+46+nl);const name=utf8(nameBytes);
    if(!name||name.startsWith('/')||/[\\:\u0000-\u001f]/.test(name)||name.split('/').some(p=>p==='..'||p==='.')||names.has(name.toLowerCase()))return invalid();
    names.add(name.toLowerCase());total+=original;
    if(total>20_000_000||original>5_000_000||(/\.xml$|\.rels$/i.test(name)&&original>MAX_XML))return invalid();
    if(b.readUInt32LE(offset)!==0x04034b50||b.readUInt16LE(offset+6)!==flags||b.readUInt16LE(offset+8)!==method)return invalid();
    const localName=b.readUInt16LE(offset+26),localExtra=b.readUInt16LE(offset+28),payload=offset+30+localName+localExtra;
    if(payload+compressed>start||!b.subarray(offset+30,offset+30+localName).equals(nameBytes)||spans.some(([a,z])=>offset<z&&payload+compressed>a))return invalid();
    spans.push([offset,payload+compressed]);
    const encoded=b.subarray(payload,payload+compressed);
    let bytes:Uint8Array;
    try {bytes=method===0?encoded:inflateRawSync(encoded,{maxOutputLength:Math.max(1,original)});}catch{return invalid();}
    if(bytes.length!==original||crc32(bytes)!==crc)return invalid();
    if(/\.xml$|\.rels$/i.test(name))output[name]=bytes;
    cursor=next;
  }
  if(cursor!==end)return invalid();
  return output;
}
function nodes(tree: Xml, action: (tag: string, attrs: Record<string, unknown>, children: Xml) => void) {
  for (const item of tree) for (const [tag,value] of Object.entries(item)) {
    if (tag === ':@' || tag === '#text' || !Array.isArray(value)) continue;
    action(tag, (item[':@'] ?? {}) as Record<string,unknown>, value as Xml); nodes(value as Xml,action);
  }
}
function local(tag: string) { return tag.split(':').at(-1)!; }
export function readDocx(data: Uint8Array): string[] {
  const entries = unpack(data);
  const bodyBytes = entries['word/document.xml']; if (!bodyBytes) fail("docx-format", "Choose a standard .docx document.");
  for (const [name, bytes] of Object.entries(entries)) {
    const tree = checkedXml(bytes);
    if (name === 'word/styles.xml') nodes(tree,(tag)=>{
      if(['vanish','webHidden','specVanish','numPr'].includes(local(tag)))
        fail('docx-structure','Default or inherited hidden/numbered styles require a reviewed plain-text export.');
    });
    if (name.endsWith('.rels')) nodes(tree,(tag,attrs)=>{
      if (local(tag)==='Relationship' && attrs['@_TargetMode']==='External') fail("docx-external", "Remove external links or save the prose as UTF-8 text.");
    });
    if (/word\/(?:header|footer|footnotes|endnotes|comments)/.test(name)) {
      let meaningful=false; nodes(tree,(tag)=>{if(local(tag)==='t')meaningful=true;});
      if(meaningful)fail("docx-structure", "Use a copy containing body paragraphs only. Headers, notes and comments require review.");
    }
  }
  const tree = checkedXml(bodyBytes);
  const elements=tree.filter(item=>Object.keys(item).some(k=>!k.startsWith('?')&&k!==':@'&&k!=='#text'));
  if(elements.length!==1||!Array.isArray(elements[0]?.['w:document'])||((elements[0]?.[':@']??{}) as Record<string,unknown>)['@_xmlns:w']!=='http://schemas.openxmlformats.org/wordprocessingml/2006/main')
    fail('docx-structure','Use a standard WordprocessingML document.');
  if(!entries['[Content_Types].xml']||!entries['_rels/.rels'])fail('docx-format','The DOCX is missing required package parts.');
  const properties:Record<string,Set<string>>={
    pPr:new Set('keepNext keepLines pageBreakBefore widowControl spacing ind jc contextualSpacing suppressAutoHyphens textAlignment outlineLvl bidi tabs tab pBdr top left bottom right between bar shd snapToGrid suppressLineNumbers wordWrap adjustRightInd mirrorIndents'.split(' ')),
    rPr:new Set('rFonts b bCs i iCs caps smallCaps strike dstrike outline shadow emboss imprint color spacing w kern position sz szCs highlight u effect bdr shd fitText vertAlign rtl cs em lang eastAsianLayout noProof snapToGrid'.split(' ')),
    sectPr:new Set('pgSz pgMar cols col docGrid type titlePg textDirection vAlign rtlGutter pgNumType formProt bidi'.split(' '))
  };
  const children:Record<string,Set<string>>={document:new Set(['body']),body:new Set(['p','sectPr']),
    p:new Set(['pPr','r','hyperlink','bookmarkStart','bookmarkEnd','proofErr']),
    r:new Set(['rPr','t','br','tab','cr','lastRenderedPageBreak']),hyperlink:new Set(['r','bookmarkStart','bookmarkEnd','proofErr'])};
  const paragraphs:string[]=[];let bodyCount=0;
  function visit(items:Xml,parent:string):string{
    let out='';
    for(const item of items)for(const [tag,value] of Object.entries(item)){
      if(tag===':@')continue;
      if(tag==='#text'){if(String(value).trim())fail('docx-structure','Text must be inside a Word text run.');continue;}
      const name=local(tag);
      if(tag!=='w:'+name||!children[parent]?.has(name)||!Array.isArray(value))fail('docx-structure','This DOCX contains unsupported content. Export and review a body-only UTF-8 copy.');
      const attrs=(item[':@']??{}) as Record<string,unknown>;
      if(Object.keys(attrs).some(k=>k==='@_xmlns:w'&&attrs[k]!=='http://schemas.openxmlformats.org/wordprocessingml/2006/main'))fail('docx-structure','Unsupported Word namespace.');
      if(properties[name]){
        nodes(value as Xml,(t,attrs)=>{if(!properties[name]!.has(local(t))||t!=='w:'+local(t)||('@_xmlns:w' in attrs&&attrs['@_xmlns:w']!=='http://schemas.openxmlformats.org/wordprocessingml/2006/main'))fail('docx-structure','Numbering, styles, hidden text, sections or unknown properties require a plain-text export.');});
        if(name==='sectPr'&&(value as Xml).some(v=>'#text' in v&&String(v['#text']).trim()))fail('docx-structure','Unsupported section content.');
        continue;
      }
      if(name==='body'){if(++bodyCount!==1)fail('docx-structure','A document must contain one body.');out+=visit(value as Xml,name);}
      else if(name==='p')paragraphs.push(visit(value as Xml,name));
      else if(name==='t'){
        if((value as Xml).some(v=>Object.keys(v).some(k=>k!=='#text')))fail('docx-structure','A Word text run cannot contain nested elements.');
        out+=(value as Xml).map(v=>String(v['#text']??'')).join('');
      }else if(['br','cr','tab','bookmarkStart','bookmarkEnd','proofErr','lastRenderedPageBreak'].includes(name)){
        if((value as Xml).length)fail('docx-structure','Unsupported nested Word content.');
        if(name==='br'||name==='cr')out+='\n';else if(name==='tab')out+='\t';
      }else out+=visit(value as Xml,name);
    }
    return out;
  }
  visit(elements[0]!['w:document'] as Xml,'document');
  if(bodyCount!==1||!paragraphs.some(p=>p.trim()))fail('empty-document','The document has no readable body paragraphs.');
  return paragraphs;
}
export function importText(data: Uint8Array, extension: string): TextDocument {
  const parts = extension.toLowerCase()==='.docx' ? readDocx(data) : utf8(data).replace(/^\uFEFF/,'').split(/\r?\n[\t ]*\r?\n/);
  if(!parts.some(p=>p.trim()))fail('empty-document','Provide a document with body text.');
  return documentSchema.parse({revision:'source-'+sha(data).slice(0,16),blocks:parts.map((text,i)=>({id:'p'+(i+1),text}))});
}
export function writeDocx(prompt: string, document: TextDocument): Uint8Array {
  function p(text: string, bold=false) {
    if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text))fail('docx-text','DOCX cannot contain these control characters.');
    const runs=text.split(/(\n|\t)/).map(t=>t==='\n'?'<w:br/>':t==='\t'?'<w:tab/>':'<w:t xml:space="preserve">'+escape(t)+'</w:t>').join('');
    return '<w:p><w:pPr><w:spacing w:after="160" w:line="320" w:lineRule="auto"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Microsoft YaHei"/><w:sz w:val="22"/>'+(bold?'<w:b/>':'')+'</w:rPr>'+runs+'</w:r></w:p>';
  }
  const xml='<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'+ (prompt?p(prompt,true):'') +document.blocks.map(b=>p(b.text)).join('')+'<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>';
  return zipSync({
    '[Content_Types].xml':strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    '_rels/.rels':strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/document.xml':strToU8(xml)
  },{level:6});
}
