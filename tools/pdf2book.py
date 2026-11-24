# -*- coding: utf-8 -*-
"""
把 PDF 轉成翻頁書要用的單頁圖片 + manifest.json，一支指令跑完。

做的事：
  1. 去出血：有 TrimBox 就照它裁；少數頁面沒設 TrimBox（如月曆第 5、8 頁），
     就套用其他頁的裁切量，避免邊緣留下出血白邊或黑線。
     整份都沒設 TrimBox、但其實有出血（如《vuvu好食》內頁）→ 加 --bleed 3
  2. 開啟色彩管理，CMYK 圖片才會正確轉成 RGB（不開顏色會偏）
  3. 每頁輸出兩張圖，都嵌入 sRGB 描述檔（否則 Safari 照片會偏艷）：
       pNN.webp      長邊 2000px，翻頁書顯示用
       pNN@zoom.jpg  長邊 3000px，雙擊放大用（WebP 載入失敗時也拿它備援）
  4. 封面、封底另外一個檔（--cover）：第 1 頁放最前面、第 2 頁放最後面，
     存成 cover、back
  5. 總頁數若是奇數，在封底前補一張與紙色相同的空白頁，
     讓封面、封底都能單獨一頁（由下往上翻的月曆不需要，加 --no-blank 跳過）
  6. 產生 manifest.json（頁序、頁面長寬比、書名）
  7. 跨頁自動切半：PDF 頁面寬 > 高（InDesign 匯出成「跨頁」）就沿正中線
     切成左右兩頁；單頁原樣輸出。同一份 PDF 混用也可以
     （如《搞什麼東東？》：第 1 頁封面、最後 1 頁封底是單頁，中間全是跨頁）

用法（在專案資料夾下執行）：
    python tools/pdf2book.py "來源.pdf" docs/pages/<代號> "書名" [選項]

選項：
    --bleed 3          整份 PDF 沒設 TrimBox 時，四邊各裁掉幾 mm
    --cover 封面.pdf   兩頁的封面檔（第 1 頁封面、第 2 頁封底），
                       可用 tools/split_cover.py 從印刷用書封檔產生
    --no-blank         奇數頁也不補空白頁

例：
    python tools/pdf2book.py "../料理快報第一刊.pdf" docs/pages/vol1 "料理快報 第一刊"
    python tools/pdf2book.py "來源.pdf" docs/pages/minsan2026 "搞什麼東東？2026台東博覽會民間參與行動紀實"

需要的套件：pip install pymupdf pillow
"""
import sys, os, json
from collections import Counter
import fitz                      # PyMuPDF：讀 PDF、渲染
from PIL import Image, ImageCms  # Pillow：壓縮、寫 sRGB 描述檔

# ── 輸出規格 ───────────────────────────────────────────────
# 為什麼顯示用 WebP q90：實測月曆，WebP q90 與 JPEG q82 畫質相同（SSIM 0.985），
# 檔案小約 7%；WebP q82 雖然只有 200KB，但紙張紋理會被抹平。
DISPLAY_PX = 2000   # 翻頁書顯示用，長邊像素
ZOOM_PX    = 3000   # 雙擊放大用，長邊像素
# 《搞什麼東東？》是照片＋文字的刊物、沒有紙紋要保留，改用 q82：
# 實測一頁 222KB（q90 是 327KB），省約 32% 流量，肉眼看不出差別。
WEBP_Q     = 82
JPEG_Q     = 82

SRGB_BYTES = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()

# 訊息一律用 UTF-8 輸出。Windows 預設是 Big5（cp950），
# 在 Git Bash、VS Code 等終端機會變成亂碼。
sys.stdout.reconfigure(encoding="utf-8")

fitz.TOOLS.set_icc(True)        # 色彩管理：CMYK → RGB 才準


def trim_rects(doc, bleed_pt=0):
    """算出每頁要保留的區域（去掉出血）。"""
    # 找出「有設 TrimBox」的頁面最常見的裁切量，給沒設的頁面套用；
    # 整份都沒設時，用 --bleed 指定的寬度
    insets = Counter()
    for p in doc:
        m, t = p.mediabox, p.trimbox
        if t != m:
            insets[(round(t.x0 - m.x0, 2), round(t.y0 - m.y0, 2),
                    round(m.x1 - t.x1, 2), round(m.y1 - t.y1, 2))] += 1
    common = insets.most_common(1)[0][0] if insets else (bleed_pt,) * 4

    rects = []
    for p in doc:
        m, t = p.mediabox, p.trimbox
        if t == m:   # 沒設 TrimBox → 套用常見裁切量
            l, top, r, b = common
            t = fitz.Rect(m.x0 + l, m.y0 + top, m.x1 - r, m.y1 - b)
        rects.append(t)
    return rects


def render(page, clip, long_px):
    """把 clip 區域渲染成長邊 long_px 的 PIL Image。"""
    z = long_px / max(clip.width, clip.height)
    pm = page.get_pixmap(matrix=fitz.Matrix(z, z), clip=clip,
                         colorspace=fitz.csRGB, alpha=False)
    return Image.frombytes("RGB", (pm.width, pm.height), pm.samples)


def fit(img, long_px):
    s = long_px / max(img.size)
    if s >= 1:
        return img
    return img.resize((round(img.width * s), round(img.height * s)), Image.LANCZOS)


def save(img, outdir, name):
    disp = fit(img, DISPLAY_PX)
    disp.save(os.path.join(outdir, name + ".webp"), "WEBP",
              quality=WEBP_Q, method=6, icc_profile=SRGB_BYTES)
    fit(img, ZOOM_PX).save(os.path.join(outdir, name + "@zoom.jpg"), "JPEG",
              quality=JPEG_Q, optimize=True, progressive=True, icc_profile=SRGB_BYTES)
    return disp.size


def paper_color(img):
    """取四個角落附近的中位數顏色當紙色，給補白頁用。"""
    w, h = img.size
    px = [img.getpixel((x, y)) for x in (20, w - 21) for y in (20, h - 21)]
    return tuple(sorted(c[i] for c in px)[len(px) // 2] for i in range(3))


def take(args, flag, default=None):
    """從參數列取出「--flag 值」，取完就移除。"""
    if flag not in args:
        return default
    i = args.index(flag)
    val = args[i + 1]
    del args[i:i + 2]
    return val


if __name__ == "__main__":
    args = sys.argv[1:]
    no_blank = "--no-blank" in args
    if no_blank:
        args.remove("--no-blank")
    bleed_pt = float(take(args, "--bleed", 0)) / 25.4 * 72   # mm → pt
    cover_src = take(args, "--cover")
    src, outdir, title = args[0], args[1], args[2]
    os.makedirs(outdir, exist_ok=True)

    # 要轉的頁面清單：(PDF 頁面, 保留區域, 輸出檔名)
    doc = fitz.open(src)
    clips = []                                        # (PDF 頁面, 保留區域)
    for p, c in zip(doc, trim_rects(doc, bleed_pt)):
        if c.width > c.height:                        # 跨頁 → 沿裝訂線切半
            mid = (c.x0 + c.x1) / 2
            clips += [(p, fitz.Rect(c.x0, c.y0, mid, c.y1)),
                      (p, fitz.Rect(mid, c.y0, c.x1, c.y1))]
        else:
            clips.append((p, c))
    fmt = "p%03d" if len(clips) >= 100 else "p%02d"   # 補零，排序才不會亂
    jobs = [(p, c, fmt % (i + 1)) for i, (p, c) in enumerate(clips)]
    if cover_src:
        cdoc = fitz.open(cover_src)
        crects = trim_rects(cdoc)
        jobs.insert(0, (cdoc[0], crects[0], "cover"))
        jobs.append((cdoc[1], crects[1], "back"))

    names, sizes, last_img = [], [], None
    for page, clip, name in jobs:
        img = render(page, clip, ZOOM_PX)
        w, h = save(img, outdir, name)
        names.append(name); sizes.append((w, h)); last_img = img
        print("  %-6s %dx%d" % (name, w, h), flush=True)

    # 奇數頁 → 封底前補一張空白頁
    if len(names) % 2 and not no_blank:
        blank = Image.new("RGB", last_img.size, paper_color(last_img))
        save(blank, outdir, "blank")
        names.insert(len(names) - 1, "blank")
        print("  原本 %d 頁（奇數），已在封底前補一張空白頁" % len(jobs))

    w, h = Counter(sizes).most_common(1)[0][0]
    manifest = {"title": title, "pageWidth": w, "pageHeight": h, "pages": names}
    with open(os.path.join(outdir, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    print("完成：共 %d 頁，頁面 %dx%d" % (len(names), w, h))
