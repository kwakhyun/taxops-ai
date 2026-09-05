"""Render the maintained decision note as one A4 page, with embedded Korean text.

Requires reportlab and a Korean TrueType font. Override PORTFOLIO_FONT_PATH
on systems without the macOS font. No application or API credentials are read.
"""

import os
import re
from pathlib import Path
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer


ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "docs/engineering-decisions.md"
OUTPUT = ROOT / "output/pdf/taxops-ai-engineering-decisions.pdf"
FONT = Path(os.environ.get(
    "PORTFOLIO_FONT_PATH", "/System/Library/Fonts/Supplemental/Arial Unicode.ttf"
))
if not FONT.is_file():
    raise SystemExit("Set PORTFOLIO_FONT_PATH to a Korean TrueType font file.")

pdfmetrics.registerFont(TTFont("PortfolioKR", str(FONT)))
pdfmetrics.registerFontFamily("PortfolioKR", normal="PortfolioKR", bold="PortfolioKR")


def inline(text: str) -> str:
    text = escape(text)
    text = re.sub(r"\[([^\]]+)\]\((https://[^)]+)\)",
                  r'<link href="\2" color="#315486"><u>\1</u></link>', text)
    text = re.sub(r"\*\*(.+?)\*\*", r'<font color="#20212A">\1</font>', text)
    return re.sub(r"`([^`]+)`", r"\1", text)


styles = {
    "title": ParagraphStyle("title", fontName="PortfolioKR", fontSize=19,
                            leading=25, textColor=colors.HexColor("#20212A"),
                            spaceAfter=10),
    "section": ParagraphStyle("section", fontName="PortfolioKR", fontSize=12.3,
                              leading=18, spaceBefore=10, spaceAfter=5,
                              textColor=colors.HexColor("#20212A"), keepWithNext=True),
    "body": ParagraphStyle("body", fontName="PortfolioKR", fontSize=10.2,
                           leading=15.6, spaceAfter=5.5,
                           alignment=TA_LEFT, textColor=colors.HexColor("#41434F")),
}


def decorate(canvas, doc):
    if doc.page > 1:
        raise RuntimeError("Decision note exceeds one page; edit the source or layout.")
    canvas.setTitle("TaxOps AI - 설계 판단과 검증 사례")
    canvas.setAuthor("TaxOps AI")
    canvas.setFillColor(colors.HexColor("#FFE600"))
    canvas.rect(38, A4[1] - 30, 52, 4, fill=1, stroke=0)
    canvas.setFont("PortfolioKR", 8)
    canvas.setFillColor(colors.HexColor("#676976"))
    canvas.drawRightString(A4[0] - 38, 24, "TaxOps AI / 설계 판단과 검증 사례 / 1")


story = []
for block in SOURCE.read_text(encoding="utf-8").strip().split("\n\n"):
    if block.startswith("# "):
        story.append(Paragraph(inline(block[2:]), styles["title"]))
    elif block.startswith("## "):
        story.append(Paragraph(inline(block[3:]), styles["section"]))
    else:
        story.append(Paragraph(inline(block.replace("\n", " ")), styles["body"]))
story.append(Spacer(1, 2))
OUTPUT.parent.mkdir(parents=True, exist_ok=True)
SimpleDocTemplate(str(OUTPUT), pagesize=A4, rightMargin=38, leftMargin=38,
                  topMargin=40, bottomMargin=38).build(
    story, onFirstPage=decorate, onLaterPages=decorate
)
print(OUTPUT.relative_to(ROOT))
