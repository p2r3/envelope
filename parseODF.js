import parseXML from "./parseXML.js";
import ZIPExtractor from "./extractZIP.js";

const getChild = (parent, tag) => {
  if (!parent) return parent;
  return parent._children.find(c => c._tag === tag);
};

const parseStyle = (style) => {

  const textProperties = getChild(style, "style:text-properties");
  const paragraphProperties = getChild(style, "style:paragraph-properties");
  const columnProperties = getChild(style, "style:table-column-properties");
  const rowProperties = getChild(style, "style:table-row-properties");
  const cellProperties = getChild(style, "style:table-cell-properties");
  const graphicProperties = getChild(style,"loext:graphic-properties")
  // loext mean its not part of the spec, yet libreoffice uses that, and libreoffice is basically the spec - anything support it

  let css = "";

  if (textProperties) {

    let prop;
    if (prop = textProperties["fo:font-weight"]) {
      css += `font-weight:${prop};`;
    }
    if (prop = textProperties["fo:font-style"]) {
      css += `font-style:${prop};`;
    }
    if (prop = textProperties["style:text-underline-style"]) {
      // Hack, prevents colliding with line-through style
      css += `border-bottom:1px ${prop};`;
    }
    if (prop = textProperties["style:text-line-through-style"]) {
      css += `text-decoration:line-through ${prop};`;
    }
    if (prop = textProperties["fo:color"]) {
      css += `color:${prop};`;
    }
    if (prop = textProperties["fo:background-color"]) {
      css += `background-color:${prop};`;
    }
    if (prop = textProperties["fo:font-size"]) {
      css += `font-size:${prop};`;
    }
    if (prop = textProperties["style:font-name"]) {
      css += `font-family:${prop};`;
    }

  }

  if (paragraphProperties) {

    let prop;
    if (prop = paragraphProperties["fo:text-align"]) {
      css += `text-align:${prop};`;
    }

  }

  if (cellProperties) {

    let prop;
    if (prop = cellProperties["fo:background-color"]) {
      css += `background-color:${prop};`;
    }

  }

  if (rowProperties) {

    let prop;
    if (prop = rowProperties["style:row-height"]) {
      css += `height:${prop};`;
    }

  }

  if (columnProperties) {

    let prop;
    if (prop = columnProperties["style:column-width"]) {
      css += `width:${prop};`;
    }

  }
  if (graphicProperties){
    let fillType;
    if (fillType = graphicProperties["draw:fill"]!='none' && graphicProperties["draw:fill"]){
      let prop;
      // solid(draw:fill-color),gradient(draw:style),bitmap(draw:fill-image),none
      // skip opacity for now
      if (prop = fillType=="solid" && graphicProperties["draw:fill-color"]){
        css+=`background-color:${prop}`
      }
      if (prop = fillType=="gradient" && graphicProperties["draw:style"]){
        const startColor = graphicProperties["draw:start-color"];
        const endColor = graphicProperties["draw:end-color"]
        // skip intensity for now
        if (prop === "radial") {
            const cx = graphicProperties["draw:cx"] || 0.5;
            const cy = graphicProperties["draw:cy"] || 0.5;
            css+=(`background: radial-gradient(circle at ${cx * 100}% ${cy * 100}%, ${startColor}, ${endColor});`);
        }
        else{
          css+=`background: linear-gradient(${startColor}, ${endColor});`
        }
      }

    }


  }
  return css;
};

const handleElement = async (element, styles, zip, layout) => {
    // look at https://github.com/LibreOffice/libetonyek/blob/c3ac91b8cf6cdb83b777b480c6c000b9542f3add/src/lib/IWORKCollector.cpp#L975 for reference.
    // they built a library to convert Apple iWork documents to open

  let htmlTag = element._tag.split(":").pop();
  let attributes = "";
  let content = "";
  let css = "";
  let repeat = 0;

  let outputBefore = "";
  let outputAfter = "";

  for (const child of element._children) {
    if (typeof child === "string") {
      content += child;
    } else {
      content += await handleElement(child, styles, zip, layout);
    }
  }

  const styleName = element[element._tag.split(":")[0] + ":style-name"];
  if (styleName) attributes += ` class="${styleName}"`;

  switch (element._tag) {
    case "text:h": htmlTag = "h1"; break;
    case "text:list": htmlTag = "ul"; break;
    case "text:list-item": htmlTag = "li"; break;
    case "text:p":
{
  htmlTag = "p";
  // each paragraph that contains frames should act like new 0,0 coordinate.
  css += "position:relative; margin:0; padding:0; min-height:1em;";
  break;
}
    case "table:table-column": {
      htmlTag = "col";

      repeat = (Number(element["table:number-columns-repeated"]) || 0) - 1;
      break;
    }
    case "table:table-row": htmlTag = "tr"; break;
    case "table:table-cell":
    {
      htmlTag = "td";
      repeat = (Number(element["table:number-columns-repeated"]) || 0) - 1;
      const rowspan = element["table:number-rows-spanned"] || 1; // rowspan 0 does not do what you think, see https://developer.mozilla.org/en-US/docs/Web/API/HTMLTableCellElement/rowSpan
      const colspan = element["table:number-columns-spanned"] || 1;
      attributes += ` rowspan="${rowspan}"`;
      attributes += ` colspan="${colspan}"`;
      content = `<div>${content}</div>`;
      break;
    }
    case "draw:image":
    {
      htmlTag = "img";
      const mime = element["draw:mime-type"];
      if (!mime) break; // libreoffice embed objects as a VCL Metafile (VCLMTF). no support for now
      const path = element["xlink:href"];
      const base64 = zip.extractBase64(path);
      attributes += ` src="data:${mime};base64,${base64}"`;
      css += "max-width:100%;";
      break;
    }
    case "draw:frame":
    {
      css += "position:absolute;"; // force all frames to be absolute, without that browser might not listen to z-index

      // the sizes are in inches, and displaied as "<N>in", so css are happy

      htmlTag = "div";
      const width = element["svg:width"]
      const height = element["svg:height"]
      const x = element["svg:x"]
      const y = element["svg:y"]
      const zindex = element["draw:z-index"]
      css+=`z-index:${zindex};`

      if (x) css += `left:${x||0};`;

      if (y) css += `top:${y||0};`;
      css += `width:${width};height:${height};`;
      break;
    }
    // blacklist tags
    case "text:sequence-decls" :
    case "office:forms":
      return ''


    default: break;
  }

  const elementHTML = `<${htmlTag}${css ? ` style="${css}"` : ""}${attributes}>${content}</${htmlTag}>`;
  let output = elementHTML;
  for (let i = 0; i < repeat; i ++) output += elementHTML;

  return outputBefore + output + outputAfter;

};

const extractDocument = async (bytes, callback) => {

  const zip = new ZIPExtractor(bytes);

  try {

    const documentXML = zip.extractText("content.xml");
    const stylesXML = zip.extractText("styles.xml");
    const document = parseXML(documentXML);
    const styles = parseXML(stylesXML);

    const collectStyles = (element) => {
      const found = [];
      for (const child of element._children) {
        if (typeof child !== "object") continue;
        if ("style:name" in child) found.push(child);
        else found.push(...collectStyles(child));
      }
      return found;
    };
    const allStyles = collectStyles(styles[0]).concat(collectStyles(document[0]));

    const masterPage = allStyles.find(c => c._tag === "style:master-page");
    const pageLayoutName = masterPage["style:page-layout-name"];
    const pageStyle = allStyles.find(c => c._tag === "style:page-layout" && c["style:name"] === pageLayoutName);
    const pageLayoutProperties = getChild(pageStyle, "style:page-layout-properties");

    const cssClasses = {};
    for (const element of allStyles) {
      const className = element["style:name"];
      if (!(className in cssClasses)) {
        cssClasses[className] = "";
      }
      const parent = element['style:parent-style-name']

      cssClasses[className] += ((cssClasses[parent] ?? '')+parseStyle(element));
    }

    let css = `<style>
      table {
        table-layout: fixed;
        width: 100%;
        border-collapse: collapse;
        margin-bottom: 1em;
      }
      td {
        background: #fff;
        border: 1px solid black;
      }
      td > div {
        white-space: nowrap;
        overflow: visible;
      }
      td * {
        margin: 0;
      }

    img {
      width: 100%;
      height: 100%;
      object-fit: fill;
  }
    `;

    for (const className in cssClasses) {
      if (!cssClasses[className]) continue;
      css += `.${className}{${cssClasses[className]}}\n`;
    }
    css += "</style>";

    const html = await callback(zip, document, allStyles, pageLayoutProperties);

    return css + html;

  } catch (e) {

    console.error("Failed to parse document, using thumbnail instead.\n", e);

    const base64 = zip.extractBase64("Thumbnails/thumbnail.png");
    return `<img src="data:image/png;base64,${base64}" style="width:100%"></img>`;

  }

};

const parseODT = async (bytes) => {
  return await extractDocument(bytes, async (zip, doc, styles, layout) => {
    let outputHTML = "";

    const elements = getChild(getChild(doc[0], "office:body"), "office:text")._children;
    for (const element of elements) {
      outputHTML += await handleElement(element, styles, zip, layout);
    }

    return outputHTML;
  });
};

const parseODP = async (bytes) => {
  return await extractDocument(bytes, async (zip, doc, styles, layout) => {
    let outputHTML = `<style>.__page{position:relative;width:100%;aspect-ratio:16/9}</style>`;

    const pages = getChild(getChild(doc[0], "office:body"), "office:presentation")
      ._children.filter(c => c._tag === "draw:page");

    for (const page of pages) {
      let pageHTML = "";
      for (const element of page._children) {
        pageHTML += await handleElement(element, styles, zip, layout);
      }
      outputHTML += `<div class="__page">${pageHTML}</div>`;
    }

    return outputHTML;
  });
};

const parseODS = async (bytes) => {
  return await extractDocument(bytes, async (zip, doc, styles, layout) => {
    let outputHTML = "";

    const elements = getChild(getChild(doc[0], "office:body"), "office:spreadsheet")._children;
    for (const element of elements) {
      outputHTML += await handleElement(element, styles, zip, layout);
    }

    return outputHTML;
  });
};

export { parseODT, parseODP, parseODS };
