const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require("docx");
const { loadReleaseNotesTemplate } = require("./config");

function parseMarkdownToParagraphs(markdown) {
  const lines = markdown.split("\n");
  const paragraphs = [];

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;

    if (line.startsWith("### ")) {
      paragraphs.push(new Paragraph({ text: line.slice(4), heading: HeadingLevel.HEADING_3 }));
    } else if (line.startsWith("## ")) {
      paragraphs.push(new Paragraph({ text: line.slice(3), heading: HeadingLevel.HEADING_2 }));
    } else if (line.startsWith("# ")) {
      paragraphs.push(new Paragraph({ text: line.slice(2), heading: HeadingLevel.HEADING_1 }));
    } else if (/^[-*]\s+/.test(line)) {
      paragraphs.push(new Paragraph({ text: line.replace(/^[-*]\s+/, ""), bullet: { level: 0 } }));
    } else {
      paragraphs.push(new Paragraph({ children: [new TextRun(line)] }));
    }
  }

  return paragraphs;
}

async function buildReleaseNotesDocx(branch, changelogMarkdown) {
  const generatedDate = new Date().toISOString().slice(0, 10);
  const template = loadReleaseNotesTemplate();

  const children = [
    new Paragraph({ text: `${template.title} — ${branch}`, heading: HeadingLevel.TITLE, spacing: { after: 80 } }),
    new Paragraph({
      children: [new TextRun({ text: `Generated ${generatedDate}`, italics: true, color: "555555" })],
      spacing: { after: 300 },
    }),
    ...parseMarkdownToParagraphs(changelogMarkdown),
  ];

  if (template.footer) {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: template.footer, italics: true, color: "888888", size: 18 })],
        spacing: { before: 400 },
      })
    );
  }

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

module.exports = { buildReleaseNotesDocx };
