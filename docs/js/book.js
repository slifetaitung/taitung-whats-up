/* ── 搞什麼東東？2026台東博覽會民間參與行動紀實 線上翻頁書 ──────────────────
   程式沿用《Zoom in Taitung》翻頁書，只換資料來源。
   資料來源：pages/<代號>/manifest.json（由 tools/pdf2book.py 產生）
   看哪一刊由網址決定：index.html?issue=<代號>；網址沒寫就看 DEFAULT_ISSUE。
   新增一刊只要轉檔到 pages/<代號>/，不必動程式碼。                  */

const DEFAULT_ISSUE = 'minsan2026';
// 只留英數、底線、連字號，避免網址被塞進奇怪的路徑
const ISSUE = (new URLSearchParams(location.search).get('issue') || DEFAULT_ISSUE)
                .replace(/[^\w-]/g, '');
const BASE  = 'pages/' + ISSUE + '/';

/* 單頁寬度下限。StPageFlip 的判斷式是：
       容器寬度 < MIN_PAGE_W × 2  →  單頁模式
   所以 320 代表「兩頁並排的總寬滿 640px 才顯示跨頁」。

   ⚠️ 這個值只決定「何時切換成跨頁」，不決定頁面多大。
      跨頁時每頁寬度 = 容器寬度 ÷ 2，跟這個值無關。

   演進（都在 2026-08-28，實測後逐步調整）：
     500 → 一律單頁（原始規格）
     440 → 想讓手機橫向跨頁，但 iPhone Pro 系列橫向只有 852–874px，卡在門檻外
     418 → 仍失敗。實測發現 Google Sites 給的 iframe 只有 672px，不是螢幕的 852px
     320 → 依實測值訂。門檻 640，對 656 的實際可用寬度留 16px 餘裕
           （不設 328 是因為那樣門檻正好等於 656，少 1px 就失效）

   實測（iPhone 15 Pro 橫向、嵌在 Google Sites、iframe 672×760）：
     單頁：每頁 491px，書高 672px → 要捲 393px
     跨頁：每頁 328px，書高 449px → 要捲 170px   ← 捲動距離砍一半

   為什麼 328px 可以接受：手機橫向本來就不是拿來讀字的。
   規格書的手機原則是「瀏覽 → 雙擊放大細看」，不是在手機上讀完整本。

   直向不受影響（寬度遠低於門檻），桌機也不受影響（本來就跨頁）。 */
const MIN_PAGE_W = 320;

/* ── 版面模式：雙頁／單頁（2026-11-24 新增，本書專用）────────────
   讀者希望手機直向也能看到雙頁展開，所以預設一律雙頁（不看螢幕寬度），
   工具列的「單頁／雙頁」按鈕可切換，選擇會記在瀏覽器裡。
   代價：手機直向雙頁時每頁只剩約 180px 寬，字看不清楚，要雙擊放大看
   （符合規格書「瀏覽 → 雙擊放大細看」的手機原則）。

   做法：StPageFlip 判斷單頁的式子是「寬度 < minWidth×2 且 usePortrait」，
   它的設定物件是共用的參照，所以執行中直接改這兩個值再 update() 就會切換：
     雙頁 → usePortrait = false（永遠跨頁）
     單頁 → usePortrait = true、minWidth 設極大（永遠單頁）               */
const LAYOUT_KEY = 'flipbook-layout';
let spread = true;
try { spread = localStorage.getItem(LAYOUT_KEY) !== 'single'; } catch (e) {}   // iframe 內可能禁用 storage

const isPhone = matchMedia('(max-width: 820px)').matches;

const $ = (id) => document.getElementById(id);
const stage = $('stage'), bookEl = $('book');

let manifest, ratio, pageFlip, imgs = [];

/* ── 依可用空間算出書本尺寸 ──────────────────────────────
   Google Sites 的 iframe 高度固定，所以要用「高度」回推寬度，
   讓整本書剛好塞滿，不會被切掉也不會留一大塊空白。            */
function fit() {
  const box = stage.getBoundingClientRect();
  const availW = box.width  - 16;   // 扣掉 .stage 的 padding
  const availH = box.height - 16;
  if (availW <= 0 || availH <= 0) return;

  // 跨頁與否由讀者選的版面模式決定（見上方 LAYOUT_KEY 說明），不再看寬度門檻
  const useSpread = spread;

  const pageW = useSpread ? Math.min(availW / 2, availH * ratio)
                          : Math.min(availW,     availH * ratio);
  const pageH = pageW / ratio;

  bookEl.classList.toggle('is-spread', useSpread);   // CSS 用它補裝訂線接縫（見 book.css）
  bookEl.style.width  = Math.floor(pageW * (useSpread ? 2 : 1)) + 'px';
  bookEl.style.height = Math.floor(pageH) + 'px';
  if (pageFlip) pageFlip.update();
}

/* ── 圖片延遲載入 ────────────────────────────────────────
   一次全載在手機上很耗流量（本刊 12 頁約 5MB，頁數多的書更可觀）。
   只載目前頁前後幾頁，翻到哪載到哪。                        */
function preload(center) {
  for (let i = center - 2; i <= center + 4; i++) {
    const img = imgs[i];
    if (img && !img.src) img.src = img.dataset.src;
  }
}

/* ── 放大檢視 ─────────────────────────────────────────── */
const zoomBox = $('zoom'), zoomImg = $('zoomImg'), zoomScroll = $('zoomScroll');
let zoomBig = false;

function openZoom(idx) {
  const name = manifest.pages[idx];
  if (!name) return;
  zoomImg.src = BASE + name + '@zoom.jpg';
  zoomImg.alt = manifest.title + ' 第 ' + (idx + 1) + ' 頁';
  zoomBox.hidden = false;
  setZoomScale(false);
  $('zoomHint').classList.remove('gone');
  setTimeout(() => $('zoomHint').classList.add('gone'), 2600);
}
function setZoomScale(big) {
  zoomBig = big;
  // 縮回時整頁塞進畫面；放大時給 2.2 倍，用原生捲動平移
  zoomImg.style.width  = big ? Math.round(zoomScroll.clientWidth * 2.2) + 'px' : 'auto';
  zoomImg.style.height = big ? 'auto' : '100%';
  zoomImg.style.maxWidth = big ? 'none' : '100%';
  if (big) {   // 放大後把視角移到中央，不然會停在左上角
    zoomScroll.scrollLeft = (zoomScroll.scrollWidth - zoomScroll.clientWidth) / 2;
  }
}
function closeZoom() { zoomBox.hidden = true; zoomImg.removeAttribute('src'); }

/* 雙頁時，依點擊位置判斷是左頁還是右頁。
   showCover 的跨頁排法：[0] [1,2] [3,4] … [最後一頁]
   → 封面單獨在右、封底單獨在左；其他跨頁的左頁一定是奇數。 */
function pageAt(clientX) {
  const i = pageFlip.getCurrentPageIndex();
  if (pageFlip.getOrientation() !== 'landscape' || i === 0) return i;
  const left  = i % 2 ? i : i - 1;
  const r = bookEl.getBoundingClientRect();
  const onRight = clientX > r.left + r.width / 2;
  return onRight && left + 1 < manifest.pages.length ? left + 1 : left;
}

/* 把目前的版面模式寫進 StPageFlip 的設定（說明見檔案上方 LAYOUT_KEY），
   並更新按鈕：按鈕上顯示的是「按下去會變成的模式」。 */
function layoutSettings() {
  const s = pageFlip.getSettings();
  s.usePortrait = !spread;
  s.minWidth = spread ? MIN_PAGE_W : 1e5;
  const btn = $('layoutBtn');
  btn.textContent = spread ? '單頁' : '雙頁';
  btn.setAttribute('aria-label', spread ? '改成單頁顯示' : '改成雙頁顯示');
}

zoomImg.addEventListener('click', () => setZoomScale(!zoomBig));
$('zoomClose').addEventListener('click', closeZoom);
addEventListener('keydown', (e) => { if (e.key === 'Escape' && !zoomBox.hidden) closeZoom(); });

/* ── 啟動 ─────────────────────────────────────────────── */
fetch(BASE + 'manifest.json')
  .then(r => r.json())
  .then(m => {
    manifest = m;
    ratio = m.pageWidth / m.pageHeight;
    document.title = m.title + '｜線上翻頁書';   // 分頁標題跟著刊名走

    // 建立頁面元素。第一頁與最後一頁標成 hard（書殼），
    // 配合 showCover 讓封面、封底各自單獨一頁。
    const last = m.pages.length - 1;
    m.pages.forEach((name, i) => {
      const d = document.createElement('div');
      d.className = 'page';
      if (i === 0 || i === last) d.dataset.density = 'hard';
      const img = document.createElement('img');
      img.dataset.src = BASE + name + '.webp';
      // 極舊的瀏覽器不支援 WebP → 改用放大用的 JPEG（只換一次，避免無限重試）
      img.onerror = () => { img.onerror = null; img.src = BASE + name + '@zoom.jpg'; };
      img.alt = m.title + ' 第 ' + (i + 1) + ' 頁';
      d.appendChild(img);
      bookEl.appendChild(d);
      imgs.push(img);
    });
    preload(0);

    $('total').textContent = m.pages.length;
    $('jumpInput').max = m.pages.length;
    fit();   // 先把容器尺寸算好，PageFlip 初始化時才量得到正確寬高

    pageFlip = new St.PageFlip(bookEl, {
      /* stretch 模式下 width/height 只拿來算頁面長寬比，所以直接給圖片原尺寸。
         原本給 320×438（比例 0.7306，圖片是 0.7310），頁框和圖片比例差一點，
         圖片上下會多出極細的留白，裝訂線接縫的修正也會因此上下錯開。 */
      width: m.pageWidth,
      height: m.pageHeight,
      size: 'stretch',
      minWidth: MIN_PAGE_W,                   // ← 單頁/跨頁的門檻，見上方註解
      maxWidth: m.pageWidth,
      minHeight: Math.round(MIN_PAGE_W / ratio),
      maxHeight: m.pageHeight,
      autoSize: false,                        // 尺寸由 fit() 決定，不讓函式庫改容器
      usePortrait: true,                      // 允許切換成單頁（手機必要）
      showCover: true,                        // 封面、封底各自單獨一頁（需總頁數為偶數）
      flippingTime: isPhone ? 450 : 800,      // 手機快一點，等待感較低
      drawShadow: !isPhone,                   // 手機關陰影省效能
      maxShadowOpacity: 0.5,
      swipeDistance: isPhone ? 20 : 30,       // 預設 30 在小螢幕偏遲鈍
      /* 這個選項名稱和它的行為相反：設 true 時 touchmove 是 passive、
         不會 preventDefault，橫向位移超過 10px 才翻頁。
         也就是「手指在書上直向滑動時，外層 Google Sites 仍然捲得動」。 */
      mobileScrollSupport: true,
      /* 鎖住「點整本書就翻頁」，只留書角可點。
         否則第一次點擊就翻頁，雙擊放大永遠觸發不了。
         翻頁改用：滑動、書角、底部按鈕、鍵盤左右鍵。 */
      disableFlipByClick: true,
      useMouseEvents: true,
    });
    layoutSettings();   // 套用雙頁／單頁模式（要在 loadFromHTML 之前，第一次排版就對）

    pageFlip.loadFromHTML(bookEl.querySelectorAll('.page'));
    $('loading').remove();

    const sync = () => {
      const i = pageFlip.getCurrentPageIndex();
      $('cur').textContent = i + 1;
      $('prev').disabled = i <= 0;
      $('next').disabled = i >= manifest.pages.length - 1;
      preload(i);
    };
    pageFlip.on('flip', sync);
    pageFlip.on('changeState', sync);
    sync();

    // 雙擊 / 手指輕點兩下 → 放大「點到的那一頁」（雙頁時分得出左頁、右頁）
    bookEl.addEventListener('dblclick', (e) => openZoom(pageAt(e.clientX)));
    let lastTap = 0;
    bookEl.addEventListener('touchend', (e) => {
      const now = Date.now();
      if (now - lastTap < 320) openZoom(pageAt(e.changedTouches[0].clientX));
      lastTap = now;
    });

    // 版面切換按鈕：雙頁 ⇄ 單頁
    $('layoutBtn').addEventListener('click', () => {
      spread = !spread;
      try { localStorage.setItem(LAYOUT_KEY, spread ? 'spread' : 'single'); } catch (e) {}
      layoutSettings();
      fit();      // 重算書本尺寸，裡面會呼叫 pageFlip.update() 觸發單頁／跨頁切換
      sync();
    });

    $('prev').addEventListener('click', () => pageFlip.flipPrev());
    $('next').addEventListener('click', () => pageFlip.flipNext());
    $('zoomBtn').addEventListener('click', () => openZoom(pageFlip.getCurrentPageIndex()));

    $('jumpForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const n = parseInt($('jumpInput').value, 10);
      if (n >= 1 && n <= manifest.pages.length) pageFlip.turnToPage(n - 1);
      $('jumpInput').blur();
    });

    addEventListener('keydown', (e) => {
      if (!zoomBox.hidden || e.target.tagName === 'INPUT') return;
      if (e.key === 'ArrowLeft')  pageFlip.flipPrev();
      if (e.key === 'ArrowRight') pageFlip.flipNext();
    });

    // 視窗尺寸改變、手機轉向都要重算。轉向後尺寸不會立刻更新，故延遲一次。
    addEventListener('resize', fit);
    addEventListener('orientationchange',
                     () => setTimeout(fit, 250));
  })
  .catch(err => { $('loading').textContent = '載入失敗：' + err.message; });

/* 全螢幕：在 iframe 裡要外層加 allow="fullscreen" 才會成功。
   瀏覽器不給就直接把按鈕藏起來，不要留一顆按了沒反應的按鈕。 */
const fsBtn = $('fsBtn');
if (!document.fullscreenEnabled) {
  fsBtn.style.display = 'none';
} else {
  fsBtn.addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  });
}
