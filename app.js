(() => {
  const STORE_KEY = "ami-diary-v2";
  const PETS_KEY = "ami-diary-v2-pets"; // 角色卡单独备份，避免大图撑爆时整包写失败丢角色
  const IDB_NAME = "ami-diary-blobs";
  const IDB_STORE = "blobs";
  const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];
  const READY_ENTRY_MIN = 3;
  const READY_CHARS_MIN = 60;
  const STOP_NAMES = new Set([
    "今天", "明天", "昨天", "我们", "你们", "他们", "什么", "一个", "这个", "那个",
    "宠物", "猫咪", "小猫", "小狗", "东西", "时候", "地方", "自己", "主人",
  ]);

  const app = document.getElementById("app");
  const pages = [...document.querySelectorAll(".page")];
  const flashEl = document.getElementById("flash");
  const toastEl = document.getElementById("toast");
  const dayModal = document.getElementById("day-modal");
  let toastTimer;
  let p2Timer;
  let pageId = "p1";
  let audioCtx = null;
  let pendingEntry = null;
  let draftVideoUrl = ""; // 会话内视频预览，不进 localStorage
  const sessionVideos = new Map(); // entryId -> blob URL
  let blobPersistTimer = null;

  const SEED_ENTRIES = [
    {
      id: "seed-0905",
      dateISO: "2026-09-05",
      pet: "小橘",
      text: "窗边晒太阳的小橘，耳朵被光烤得暖乎乎。",
      caption: "窗边晒太阳的小橘",
      image: "assets/eject-cat.jpg",
    },
    {
      id: "seed-0914",
      dateISO: "2026-09-14",
      pet: "小花",
      text: "海边风有点大，小花躲在镜头后面只露出半张脸。",
      caption: "海边的小花",
      image: "assets/ami-memories.png",
    },
    {
      id: "seed-0923",
      dateISO: "2026-09-23",
      pet: "小黑",
      text: "白花开了一丛。小黑路过，允许被拍一张。",
      caption: "白花旁的小黑",
      image: "assets/ami-theater-select.png",
    },
    {
      id: "seed-0501",
      dateISO: "2026-05-01",
      pet: "小橘",
      text: "小橘今天趴在窗边睡了一整个下午，阳光把耳朵晒得暖乎乎的。醒来只抬了一下眼皮，又继续做梦。",
      caption: "窗边晒太阳",
      image: "assets/eject-cat.jpg",
    },
    {
      id: "seed-0504",
      dateISO: "2026-05-04",
      pet: "小橘",
      text: "玩具老鼠被拍到沙发底下，它盯着洞口等了很久，最后决定假装毫不在意。",
      caption: "假装冷静",
      image: "assets/ami-theater-select.png",
    },
    {
      id: "seed-0508",
      dateISO: "2026-05-08",
      pet: "小花",
      text: "小花听见袋袋声立刻冲过来，围着转了三圈。纸箱一落地，人就不见了——只剩尾巴在门口扫。",
      caption: "袋袋警报",
      image: "assets/ami-theater-select.png",
    },
    {
      id: "seed-0510",
      dateISO: "2026-05-10",
      pet: "小花",
      text: "雨声很大，它钻进纸箱里只露出一条尾巴。我路过时，尾巴轻轻晃了一下。",
      caption: "纸箱避雨",
      image: "assets/ami-journal-cover.png",
    },
    {
      id: "seed-0512",
      dateISO: "2026-05-12",
      pet: "小黑",
      text: "白天几乎不露面。夜里跳上书架，居高临下看了一眼，允许摸下巴三秒。",
      caption: "书架夜巡",
      image: "assets/ami-p3-calendar.png",
    },
    {
      id: "seed-0517",
      dateISO: "2026-05-17",
      pet: "小黑",
      text: "晚上非要挤进被子边缘，却不许碰背。只把下巴搁到手指上，算是最大的信任。",
      caption: "只准摸下巴",
      image: "assets/ami-p1-capture.png",
    },
  ];

  const SEED_TODOS = [
    { id: "t1", text: "猫砂快用完了，本周内补货", source: "来自 5/10 日记", done: false },
    { id: "t2", text: "小橘驱虫已到提醒日，确认是否完成", source: "来自健康提醒", done: false },
    { id: "t3", text: "小花爱吃的那款粮只剩半袋", source: "来自 5/8 日记", done: false },
    { id: "t4", text: "预约小黑年度体检", source: "来自待办抽取", done: false },
  ];

  function defaultState() {
    const now = new Date();
    return {
      entries: [],
      todos: [],
      pets: [], // { id, name, entryCount, chars, traits, theaterUnlocked, avatar }
      draft: { text: "", image: "", pet: "", mediaType: "image" },
      calYear: now.getFullYear(),
      calMonth: now.getMonth(),
    };
  }

  function mergePets(primary, backup) {
    const map = new Map();
    const put = (p) => {
      if (!p || !p.name) return;
      const prev = map.get(p.name);
      if (!prev) {
        map.set(p.name, { ...p });
        return;
      }
      map.set(p.name, {
        ...prev,
        ...p,
        entryCount: Math.max(prev.entryCount || 0, p.entryCount || 0),
        chars: Math.max(prev.chars || 0, p.chars || 0),
        traits: p.traits || prev.traits || "",
        avatar: p.avatar || prev.avatar || "",
        theaterUnlocked:
          p.theaterUnlocked === false && prev.theaterUnlocked === false ? false : true,
        id: prev.id || p.id,
      });
    };
    (primary || []).forEach(put);
    (backup || []).forEach(put);
    return [...map.values()];
  }

  function openBlobDb() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error("no-idb"));
        return;
      }
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error("idb"));
    });
  }

  function idbPut(key, value) {
    return openBlobDb().then(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(IDB_STORE, "readwrite");
          tx.objectStore(IDB_STORE).put(value, key);
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => {
            db.close();
            reject(tx.error);
          };
        })
    );
  }

  function idbGet(key) {
    return openBlobDb().then(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(IDB_STORE, "readonly");
          const req = tx.objectStore(IDB_STORE).get(key);
          req.onsuccess = () => {
            db.close();
            resolve(req.result);
          };
          req.onerror = () => {
            db.close();
            reject(req.error);
          };
        })
    );
  }

  function blobRef(kind, id) {
    return `__blob__:${kind}:${id}`;
  }

  function parseBlobRef(value) {
    if (!value || typeof value !== "string" || !value.startsWith("__blob__:")) return null;
    const parts = value.split(":");
    if (parts.length < 3) return null;
    return { kind: parts[1], id: parts.slice(2).join(":") };
  }

  function queueBlobPersist() {
    clearTimeout(blobPersistTimer);
    blobPersistTimer = setTimeout(() => {
      persistBlobs().catch(() => {});
    }, 80);
  }

  async function persistBlobs() {
    const jobs = [];
    state.entries.forEach((e) => {
      if (e?.id && e.image && String(e.image).startsWith("data:")) {
        jobs.push(idbPut(`entry:${e.id}`, e.image));
      }
    });
    state.pets.forEach((p) => {
      const key = p.id || p.name;
      if (key && p.avatar && String(p.avatar).startsWith("data:")) {
        jobs.push(idbPut(`pet:${key}`, p.avatar));
      }
    });
    if (!jobs.length) return;
    await Promise.allSettled(jobs);
  }

  async function hydrateBlobs() {
    let changed = false;
    for (const e of state.entries) {
      const ref = parseBlobRef(e.image);
      if (ref) {
        try {
          const data = await idbGet(`${ref.kind}:${ref.id}`);
          if (data) {
            e.image = data;
            changed = true;
          }
        } catch {
          /* ignore */
        }
      } else if (e?.id && (!e.image || e.image === "assets/eject-cat.jpg")) {
        try {
          const data = await idbGet(`entry:${e.id}`);
          if (data) {
            e.image = data;
            changed = true;
          }
        } catch {
          /* ignore */
        }
      }
    }
    for (const p of state.pets) {
      const ref = parseBlobRef(p.avatar);
      const key = p.id || p.name;
      if (ref) {
        try {
          const data = await idbGet(`${ref.kind}:${ref.id}`);
          if (data) {
            p.avatar = data;
            changed = true;
          }
        } catch {
          /* ignore */
        }
      } else if (key && !p.avatar) {
        try {
          const data = await idbGet(`pet:${key}`);
          if (data) {
            p.avatar = data;
            changed = true;
          }
        } catch {
          /* ignore */
        }
      }
    }
    if (changed) {
      buildCalendar();
      buildShelf();
      buildTheater();
      syncDraftUI();
    }
  }

  function savePetsBackup() {
    try {
      localStorage.setItem(PETS_KEY, JSON.stringify(state.pets));
      return true;
    } catch {
      try {
        const slim = state.pets.map((p) => {
          const copy = { ...p };
          if (copy.avatar && String(copy.avatar).startsWith("data:")) {
            copy.avatar = blobRef("pet", copy.id || copy.name);
          }
          return copy;
        });
        localStorage.setItem(PETS_KEY, JSON.stringify(slim));
        return true;
      } catch {
        return false;
      }
    }
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      let parsed = raw ? JSON.parse(raw) : null;
      if (!parsed) parsed = {};
      const base = defaultState();
      let petsBackup = [];
      try {
        petsBackup = JSON.parse(localStorage.getItem(PETS_KEY) || "[]");
        if (!Array.isArray(petsBackup)) petsBackup = [];
      } catch {
        petsBackup = [];
      }
      const pets = mergePets(
        Array.isArray(parsed.pets) ? parsed.pets : [],
        petsBackup
      );
      return {
        ...base,
        ...parsed,
        entries: Array.isArray(parsed.entries) ? parsed.entries : [],
        todos: Array.isArray(parsed.todos) ? parsed.todos : [],
        pets,
        draft: {
          ...base.draft,
          ...(parsed.draft || {}),
          image: "", // 草稿大图只留在内存
        },
      };
    } catch {
      return defaultState();
    }
  }

  let state = loadState();

  function saveState() {
    // 角色卡单独备份，避免整包写失败时丢角色
    savePetsBackup();

    const draftSafe = {
      text: state.draft.text || "",
      image: "",
      pet: state.draft.pet || "",
      mediaType: state.draft.mediaType || "image",
    };

    const write = (entries, pets) => {
      localStorage.setItem(
        STORE_KEY,
        JSON.stringify({
          entries,
          todos: state.todos,
          pets,
          draft: draftSafe,
          calYear: state.calYear,
          calMonth: state.calMonth,
        })
      );
    };

    // 优先整图直存（恢复原先可点开/可预览的行为）
    try {
      write(state.entries, state.pets);
      queueBlobPersist();
      return;
    } catch {
      /* 空间不够再降级 */
    }

    queueBlobPersist();
    const slimEntries = state.entries.map((e) => ({
      ...e,
      image:
        e.image && String(e.image).startsWith("data:")
          ? blobRef("entry", e.id)
          : e.image || "",
    }));
    const slimPets = state.pets.map((p) => ({
      ...p,
      avatar:
        p.avatar && String(p.avatar).startsWith("data:")
          ? blobRef("pet", p.id || p.name)
          : p.avatar || "",
    }));
    try {
      write(slimEntries, slimPets);
      toast("存储偏满：大图已转存，日记与角色仍保留");
    } catch {
      try {
        write(
          slimEntries.map((e) => ({
            ...e,
            image: String(e.image || "").startsWith("__blob__:")
              ? "assets/eject-cat.jpg"
              : e.image,
          })),
          slimPets.map((p) => {
            const copy = { ...p };
            if (String(copy.avatar || "").startsWith("__blob__:")) delete copy.avatar;
            return copy;
          })
        );
        toast("存储紧张：已保住文字与角色");
      } catch {
        toast("本机存储不足，请清理后再试");
      }
    }
  }

  function isUsableImage(src) {
    const s = String(src || "");
    return Boolean(s) && !s.startsWith("__blob__:");
  }

  function thumbUrl(src) {
    return isUsableImage(src) ? src : "assets/eject-cat.jpg";
  }

  async function ensureEntryImage(e) {
    if (!e) return;
    if (isUsableImage(e.image)) return;
    const ref = parseBlobRef(e.image);
    const key = ref ? `${ref.kind}:${ref.id}` : e.id ? `entry:${e.id}` : "";
    if (key) {
      try {
        const data = await idbGet(key);
        if (data) {
          e.image = data;
          return;
        }
      } catch {
        /* ignore */
      }
    }
    if (!isUsableImage(e.image)) e.image = "assets/eject-cat.jpg";
  }

  function ensureAudio() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) audioCtx = new AC();
    }
    if (audioCtx?.state === "suspended") audioCtx.resume();
    return audioCtx;
  }

  function playShutter() {
    const ctx = ensureAudio();
    if (!ctx) return;
    const now = ctx.currentTime;
    const click = ctx.createOscillator();
    const clickGain = ctx.createGain();
    click.type = "square";
    click.frequency.setValueAtTime(220, now);
    click.frequency.exponentialRampToValueAtTime(55, now + 0.05);
    clickGain.gain.setValueAtTime(0.0001, now);
    clickGain.gain.exponentialRampToValueAtTime(0.22, now + 0.008);
    clickGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.07);
    click.connect(clickGain);
    clickGain.connect(ctx.destination);
    click.start(now);
    click.stop(now + 0.08);

    const dur = 0.06;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    const noise = ctx.createBufferSource();
    const noiseGain = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = 1800;
    noise.buffer = buffer;
    noiseGain.gain.setValueAtTime(0.18, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    noise.connect(filter);
    filter.connect(noiseGain);
    noiseGain.connect(ctx.destination);
    noise.start(now);

    const motor = ctx.createOscillator();
    const motorGain = ctx.createGain();
    motor.type = "sawtooth";
    motor.frequency.setValueAtTime(90, now + 0.12);
    motor.frequency.linearRampToValueAtTime(70, now + 1.1);
    motorGain.gain.setValueAtTime(0.0001, now + 0.12);
    motorGain.gain.exponentialRampToValueAtTime(0.04, now + 0.2);
    motorGain.gain.exponentialRampToValueAtTime(0.0001, now + 1.15);
    motor.connect(motorGain);
    motorGain.connect(ctx.destination);
    motor.start(now + 0.12);
    motor.stop(now + 1.2);
  }

  function toast(msg) {
    toastEl.hidden = false;
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.classList.remove("show");
      setTimeout(() => (toastEl.hidden = true), 220);
    }, 1700);
  }

  function flash() {
    flashEl.hidden = false;
    flashEl.classList.remove("bang");
    void flashEl.offsetWidth;
    flashEl.classList.add("bang");
    setTimeout(() => {
      flashEl.classList.remove("bang");
      flashEl.hidden = true;
    }, 560);
  }

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function formatDateISO(d = new Date()) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  function formatStamp(iso) {
    const [y, m, d] = iso.split("-");
    return `${y}.${m}.${d}`;
  }

  function formatJournalDate(iso) {
    const dt = new Date(iso + "T12:00:00");
    const m = pad2(dt.getMonth() + 1);
    const d = pad2(dt.getDate());
    return `${m}.${d} · 周${WEEKDAYS[dt.getDay()]}`;
  }

  function normalizePetName(name) {
    return String(name || "")
      .replace(/[，。！？、,.!?\s]/g, "")
      .slice(0, 6);
  }

  function isPetReady(pet) {
    if (!pet) return false;
    return (pet.entryCount || 0) >= READY_ENTRY_MIN || (pet.chars || 0) >= READY_CHARS_MIN;
  }

  function findPetByName(name) {
    const n = normalizePetName(name);
    return state.pets.find((p) => p.name === n);
  }

  function ensurePet(name, opts = {}) {
    const n = normalizePetName(name);
    if (!n || STOP_NAMES.has(n) || n.length < 1) return null;
    let pet = findPetByName(n);
    if (!pet) {
      pet = {
        id: "pet-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
        name: n,
        entryCount: 0,
        chars: 0,
        traits: "",
        theaterUnlocked: false,
      };
      state.pets.push(pet);
    }
    if (opts.unlockTheater) pet.theaterUnlocked = true;
    if (opts.addEntry) {
      pet.entryCount += 1;
      pet.chars += opts.chars || 0;
      pet.theaterUnlocked = true;
    }
    return pet;
  }

  function extractPetNames(text) {
    const t = String(text || "");
    const found = new Set();
    const push = (raw) => {
      const n = normalizePetName(raw);
      if (n && !STOP_NAMES.has(n) && n.length <= 6) found.add(n);
    };

    // 已知演示名 / 已有宠物直接命中
    ["小橘", "小桔", "小花", "小黑", ...state.pets.map((p) => p.name)].forEach((n) => {
      if (n && t.includes(n)) push(n === "小桔" ? "小橘" : n);
    });

    const patterns = [
      /(?:叫|名叫|名字是|名字叫|昵称是)\s*([小]?[\u4e00-\u9fffA-Za-z]{1,4})/g,
      /我家(?:的)?\s*([小]?[\u4e00-\u9fff]{1,3})(?:猫|狗|宠|呀|啊|哦)?/g,
      /领养了?\s*([小]?[\u4e00-\u9fff]{1,3})/g,
      /宠物(?:叫|是)\s*([小]?[\u4e00-\u9fffA-Za-z]{1,4})/g,
    ];
    patterns.forEach((re) => {
      let m;
      const r = new RegExp(re.source, re.flags);
      while ((m = r.exec(t))) push(m[1]);
    });
    return [...found];
  }

  function extractTodoTexts(text) {
    const t = String(text || "").trim();
    if (!t) return [];
    const hit =
      /要买|记得|别忘|待办|提醒|补充|预约|该\S{0,6}了|快用完|只剩|下周|本周内|需要买|猫砂|猫粮|驱虫|体检/.test(
        t
      );
    if (!hit) return [];
    // 按句号拆，留下像待办的短句；否则整段入库
    const parts = t
      .split(/[。！？\n]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((s) =>
        /要买|记得|别忘|待办|提醒|补充|预约|该|快用完|只剩|猫砂|猫粮|驱虫|体检|需要/.test(s)
      );
    const list = parts.length ? parts : [t];
    return list.map((s) => (s.length > 40 ? s.slice(0, 40) + "…" : s)).slice(0, 3);
  }

  function ingestTextSignals(text, { fromEntry = false } = {}) {
    const names = extractPetNames(text);
    const todos = extractTodoTexts(text);
    const createdPets = [];
    names.forEach((n) => {
      const pet = ensurePet(n, {
        unlockTheater: true,
        addEntry: fromEntry,
        chars: fromEntry ? text.length : 0,
      });
      if (pet) createdPets.push(pet);
    });
    let todoAdded = 0;
    todos.forEach((line) => {
      const exists = state.todos.some((x) => !x.done && x.text === line);
      if (exists) return;
      state.todos.unshift({
        id: "t-" + Date.now() + "-" + todoAdded,
        text: line,
        source: "来自日记抽取",
        done: false,
      });
      todoAdded += 1;
    });
    return { names, todoAdded, pets: createdPets };
  }

  function guessPet(text) {
    const extracted = extractPetNames(text);
    if (extracted.length) return extracted[0];
    const hit = state.pets.find((p) => text.includes(p.name));
    if (hit) return hit.name;
    return "";
  }

  let shelfManaging = false;

  function buildShelf() {
    const shelf = document.getElementById("book-shelf");
    const empty = document.getElementById("shelf-empty");
    const sub = document.getElementById("shelf-sub");
    const manageBtn = document.getElementById("shelf-manage-btn");
    if (!shelf) return;

    const openTodos = state.todos.filter((t) => !t.done);
    const showTodo = state.todos.length > 0;
    const pets = state.pets;

    shelf.innerHTML = "";
    shelf.classList.toggle("is-managing", shelfManaging);
    if (manageBtn) {
      manageBtn.classList.toggle("is-on", shelfManaging);
      manageBtn.textContent = shelfManaging ? "完成管理" : "管理本子";
    }

    if (showTodo) {
      const wrap = document.createElement("div");
      wrap.className = "mini-book-wrap";
      wrap.innerHTML = `
        <button type="button" class="mini-book is-todo" data-act="open-book" data-book="todo" aria-label="待办本">
          <span class="mini-spine"></span>
          <span class="mini-face">
            <strong>待办本</strong>
            <em>${openTodos.length ? openTodos.length + " 件" : "To-do"}</em>
          </span>
        </button>`;
      shelf.appendChild(wrap);
    }

    pets.forEach((pet, i) => {
      const tone = i % 3 === 1 ? "is-hua" : i % 3 === 2 ? "is-hei" : "";
      const wrap = document.createElement("div");
      wrap.className = "mini-book-wrap";
      const safe = pet.name.replace(/"/g, "&quot;");
      wrap.innerHTML = `
        <button type="button" class="mini-book is-pet ${tone}" data-act="open-book" data-book="${safe}" aria-label="${safe}的本">
          <span class="mini-spine"></span>
          <span class="mini-face">
            <strong>${pet.name}</strong>
            <em>日记 · ${pet.entryCount || 0}</em>
          </span>
        </button>
        <div class="mini-book-tools">
          <button type="button" class="mini-book-tool" data-act="rename-pet" data-pet="${safe}">改名</button>
          <button type="button" class="mini-book-tool is-danger" data-act="delete-pet" data-pet="${safe}">删除</button>
        </div>`;
      shelf.appendChild(wrap);
    });

    const isEmpty = !showTodo && pets.length === 0;
    shelf.classList.toggle("is-empty", isEmpty);
    if (empty) empty.hidden = !isEmpty;
    if (sub) {
      sub.textContent = shelfManaging
        ? "管理中：可改名或删除角色本"
        : isEmpty
          ? "点「新增本子」创建，或在日记里写上宠物名"
          : "点本子打开 · 「管理本子」可改名/删除";
    }
  }

  function addPetBook() {
    const raw = window.prompt("新本子叫什么名字？（例如：小花）", "");
    if (raw == null) return;
    const n = normalizePetName(raw);
    if (!n) {
      toast("名字不能为空");
      return;
    }
    if (findPetByName(n)) {
      toast("已有同名本子");
      return;
    }
    ensurePet(n, { unlockTheater: true });
    // 把最近未归属日记归入这本（可选）
    const orphans = state.entries.filter((e) => !e.pet);
    if (orphans.length) {
      const ok = window.confirm(`要把 ${orphans.length} 条未归属日记归入「${n}」吗？`);
      if (ok) {
        orphans.forEach((e) => {
          e.pet = n;
        });
        const pet = findPetByName(n);
        if (pet) {
          pet.entryCount = (pet.entryCount || 0) + orphans.length;
          pet.chars = (pet.chars || 0) + orphans.reduce((s, e) => s + (e.text || "").length, 0);
          pet.theaterUnlocked = true;
        }
      }
    }
    saveState();
    shelfManaging = false;
    buildShelf();
    buildTheater();
    toast(`已新增「${n}」`);
  }

  function deletePetBook(name) {
    const pet = findPetByName(name);
    if (!pet) return;
    const ok = window.confirm(`删除手账本「${name}」？\n月历里的照片还在，只是不再挂在这本下。`);
    if (!ok) return;
    state.pets = state.pets.filter((p) => p.name !== name);
    state.entries.forEach((e) => {
      if (e.pet === name) e.pet = "";
    });
    if (currentBookPet === name) currentBookPet = state.pets[0]?.name || "";
    if (currentPetId === name) currentPetId = state.pets[0]?.name || "";
    saveState();
    buildShelf();
    buildTheater();
    toast(`已删除「${name}」`);
  }

  function toggleShelfManage() {
    shelfManaging = !shelfManaging;
    buildShelf();
  }

  /** 提交时若未识别到名字，引导用户指定/新建本子 */
  function resolvePetForEntry(text, guessed) {
    if (guessed) return guessed;
    if (state.pets.length) {
      const list = state.pets.map((p) => p.name).join("、");
      const pick = window.prompt(
        `未识别到宠物名。\n输入要记入的本子名（已有：${list}）\n也可输入新名字新建一本：`,
        state.pets[0].name
      );
      if (pick == null || !normalizePetName(pick)) return "";
      return normalizePetName(pick);
    }
    const created = window.prompt(
      "还没有角色手账本。\n给宠物起个名字会自动建本（可取消，稍后在手账本新增）：",
      ""
    );
    if (created == null || !normalizePetName(created)) return "";
    return normalizePetName(created);
  }

  let theaterManaging = false;
  let avatarTargetPet = "";

  function buildTheater() {
    const page = document.querySelector('.page[data-page="t1"]');
    const empty = document.getElementById("theater-empty");
    const list = document.getElementById("theater-pets");
    const note = document.getElementById("theater-note");
    const manageBtn = document.getElementById("theater-manage-btn");
    if (!list) return;

    state.pets.forEach((p) => {
      if (p.theaterUnlocked == null) p.theaterUnlocked = true;
      if ((p.entryCount || 0) > 0) p.theaterUnlocked = true;
    });

    const pets = state.pets.filter((p) => p.theaterUnlocked !== false);
    const has = pets.length > 0;
    page?.classList.toggle("has-pets", has);
    if (empty) empty.hidden = has;
    list.hidden = !has;
    list.classList.toggle("is-managing", theaterManaging);
    if (manageBtn) {
      manageBtn.classList.toggle("is-on", theaterManaging);
      manageBtn.textContent = theaterManaging ? "完成管理" : "管理角色";
    }
    if (note) {
      note.textContent = theaterManaging
        ? "管理中：可改名或删除角色卡。"
        : "可以先建角色卡；性格互动要靠日记慢慢长出来，需要一些时间完善。";
    }

    list.innerHTML = "";
    if (!has) return;

    pets.forEach((pet) => {
      const ready = isPetReady(pet);
      const wrap = document.createElement("div");
      wrap.className = "theater-pet" + (ready ? " is-ready" : "");
      const safe = pet.name.replace(/"/g, "&quot;");
      const avatarInner = pet.avatar
        ? `<img src="${pet.avatar}" alt="" />`
        : `<span class="avatar-letter">${pet.name.slice(0, 1)}</span>`;
      wrap.innerHTML = `
        <div class="theater-pet-avatar" aria-hidden="true">
          ${avatarInner}
          <button type="button" class="theater-avatar-btn" data-act="pet-avatar" data-pet="${safe}" aria-label="为${safe}设置头像">＋</button>
        </div>
        <button type="button" class="theater-pet-main" data-act="pick-pet" data-pet="${safe}" aria-label="和${safe}对话">
          <span class="theater-pet-name">${pet.name}</span>
          <span class="theater-pet-tag">${
            ready ? "可互动" : "卡已建 · 互动待完善"
          }</span>
        </button>
        <div class="theater-pet-tools">
          <button type="button" class="mini-book-tool" data-act="rename-pet" data-pet="${safe}">改名</button>
          <button type="button" class="mini-book-tool" data-act="pet-avatar" data-pet="${safe}">换头像</button>
          <button type="button" class="mini-book-tool is-danger" data-act="delete-pet" data-pet="${safe}">删除</button>
        </div>`;
      list.appendChild(wrap);
    });
  }

  function pickPetAvatar(petName) {
    const pet = findPetByName(petName);
    if (!pet) {
      toast("角色不存在");
      return;
    }
    avatarTargetPet = pet.name;
    document.getElementById("theater-avatar-file")?.click();
  }

  async function onTheaterAvatarFile(file) {
    if (!avatarTargetPet || !file) return;
    if (!file.type.startsWith("image/")) {
      toast("请选择图片");
      return;
    }
    const pet = findPetByName(avatarTargetPet);
    if (!pet) return;
    try {
      toast("头像处理中…");
      // 头像更小，单独压缩
      const dataUrl = await compressImage(file);
      pet.avatar = dataUrl;
      saveState();
      buildTheater();
      if (pageId === "t2" && currentPetId === pet.name) {
        syncChatHeroAvatar(pet);
      }
      toast(`已更新「${pet.name}」头像`);
    } catch {
      toast("头像读取失败，换一张试试");
    } finally {
      avatarTargetPet = "";
    }
  }

  function syncChatHeroAvatar(pet) {
    const img = document.getElementById("chat-avatar-img");
    const letter = document.getElementById("chat-avatar-letter");
    const btn = document.getElementById("chat-avatar-btn");
    const profileName = document.getElementById("chat-profile-name");
    if (btn) btn.dataset.pet = pet?.name || "";
    if (profileName) profileName.textContent = pet?.name || "—";
    if (!img || !letter) return;
    if (pet?.avatar) {
      img.src = pet.avatar;
      img.hidden = false;
      letter.hidden = true;
    } else {
      img.removeAttribute("src");
      img.hidden = true;
      letter.hidden = false;
      letter.textContent = (pet?.name || "—").slice(0, 1);
    }
  }

  function addTheaterCard() {
    const raw = window.prompt("新角色卡叫什么名字？（例如：小花）", "");
    if (raw == null) return;
    const n = normalizePetName(raw);
    if (!n) {
      toast("名字不能为空");
      return;
    }
    if (findPetByName(n)) {
      const pet = findPetByName(n);
      pet.theaterUnlocked = true;
      saveState();
      theaterManaging = false;
      buildTheater();
      buildShelf();
      toast(`「${n}」已在放映室`);
      return;
    }
    const pet = ensurePet(n, { unlockTheater: true });
    if (pet) {
      pet.traits = "";
      pet.theaterUnlocked = true;
    }
    saveState();
    theaterManaging = false;
    buildTheater();
    buildShelf();
    toast(`已建「${n}」角色卡 · 互动还需日记积累`);
  }

  function toggleTheaterManage() {
    theaterManaging = !theaterManaging;
    buildTheater();
  }

  function renamePet(oldName, nextName) {
    const pet = findPetByName(oldName);
    if (!pet) return false;
    const n = normalizePetName(nextName);
    if (!n) {
      toast("名字不能为空");
      return false;
    }
    if (n !== pet.name && findPetByName(n)) {
      toast("已有同名本子");
      return false;
    }
    const prev = pet.name;
    pet.name = n;
    state.entries.forEach((e) => {
      if (e.pet === prev) e.pet = n;
    });
    if (state.draft.pet === prev) state.draft.pet = n;
    if (currentBookPet === prev) currentBookPet = n;
    if (currentPetId === prev) currentPetId = n;
    saveState();
    buildShelf();
    buildTheater();
    if (pageId === "j2") renderJournal();
    if (pageId === "t2") selectPet(n);
    toast(`已改为「${n}」`);
    return true;
  }

  function askRename(fromName) {
    const name = fromName || currentBookPet;
    if (!name) {
      toast("还没有可改名的本子");
      return;
    }
    const next = window.prompt(`给「${name}」改个名字（识别错了可以改）`, name);
    if (next == null) return;
    renamePet(name, next);
  }

  function applyFilmLook(ctx, width, height) {
    const id = ctx.getImageData(0, 0, width, height);
    const px = id.data;
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i],
        g = px[i + 1],
        b = px[i + 2];
      px[i] = Math.min(255, r * 0.42 + g * 0.38 + b * 0.12 + 18);
      px[i + 1] = Math.min(255, r * 0.28 + g * 0.42 + b * 0.18 + 12);
      px[i + 2] = Math.min(255, r * 0.18 + g * 0.28 + b * 0.36 + 6);
    }
    ctx.putImageData(id, 0, 0);
  }

  function canvasToCover(canvas) {
    return canvas.toDataURL("image/jpeg", 0.78);
  }

  function compressImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const max = 900;
        let { width, height } = img;
        const scale = Math.min(1, max / Math.max(width, height));
        width = Math.round(width * scale);
        height = Math.round(height * scale);
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        applyFilmLook(ctx, width, height);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL("image/jpeg", 0.7));
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("image"));
      };
      img.src = url;
    });
  }

  /** 从视频抽一帧作拍立得封面（约 0.8s 或中间帧） */
  function extractVideoCover(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const video = document.createElement("video");
      video.preload = "metadata";
      video.muted = true;
      video.playsInline = true;
      video.setAttribute("playsinline", "true");

      const fail = () => {
        URL.revokeObjectURL(url);
        reject(new Error("video"));
      };

      video.onerror = fail;
      video.onloadedmetadata = () => {
        const dur = Number.isFinite(video.duration) ? video.duration : 1;
        const t = Math.min(Math.max(dur * 0.2, 0.1), Math.max(dur - 0.05, 0.1));
        const onSeeked = () => {
          try {
            const max = 1100;
            let width = video.videoWidth || 720;
            let height = video.videoHeight || 720;
            if (!width || !height) throw new Error("size");
            const scale = Math.min(1, max / Math.max(width, height));
            width = Math.round(width * scale);
            height = Math.round(height * scale);
            const canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext("2d");
            ctx.drawImage(video, 0, 0, width, height);
            applyFilmLook(ctx, width, height);
            const cover = canvasToCover(canvas);
            // 保留 blob URL 供本会话回放；封面进草稿
            resolve({ cover, videoUrl: url });
          } catch {
            fail();
          }
        };
        video.addEventListener("seeked", onSeeked, { once: true });
        try {
          video.currentTime = t;
        } catch {
          // 部分机型 seek 失败：直接尝试当前帧
          setTimeout(onSeeked, 120);
        }
      };
      video.src = url;
      video.load();
    });
  }

  function syncDraftUI() {
    const preview = document.getElementById("p1-preview");
    const hint = document.getElementById("p1-hint");
    const badge = document.getElementById("p1-media-badge");
    const text = document.getElementById("p1-text");
    if (text && text.value !== state.draft.text) text.value = state.draft.text || "";
    if (preview) {
      if (state.draft.image) {
        preview.src = state.draft.image;
        preview.hidden = false;
      } else {
        preview.removeAttribute("src");
        preview.hidden = true;
      }
    }
    if (badge) {
      const isVideo = state.draft.mediaType === "video";
      badge.hidden = !isVideo || !state.draft.image;
    }
    if (hint) {
      if (!state.draft.image) {
        hint.textContent = "点相框选图 · 写一句 · 再点下方相机";
      } else if (state.draft.mediaType === "video") {
        hint.textContent = "已选视频 · 写一句后点下方相机";
      } else {
        hint.textContent = "已选照片 · 写一句后点下方相机";
      }
    }
    syncCaptionPh();
  }

  function resetEjectScene() {
    const cam = document.querySelector(".cam");
    const chute = document.getElementById("eject-chute");
    const polaroid = document.getElementById("eject-polaroid");
    const veil = document.getElementById("develop-veil");
    const cont = document.getElementById("eject-continue");
    cam?.classList.remove("is-ready", "is-shooting");
    chute?.classList.remove("is-ejecting");
    polaroid?.classList.remove("is-ejecting", "is-developed");
    veil?.classList.remove("is-clear");
    if (cont) cont.hidden = true;
    if (chute) void chute.offsetWidth;
  }

  function commitPendingEntry() {
    if (!pendingEntry) return;
    // 同日可多张：只追加，不再按 dateISO 覆盖旧片
    state.entries.unshift(pendingEntry);
    if (draftVideoUrl && pendingEntry.mediaType === "video") {
      sessionVideos.set(pendingEntry.id, draftVideoUrl);
    }
    draftVideoUrl = "";
    state.draft = { text: "", image: "", pet: pendingEntry.pet, mediaType: "image" };
    pendingEntry = null;
    saveState();
    syncDraftUI();
    buildCalendar();
  }

  function runEjectAnimation() {
    const cam = document.querySelector(".cam");
    const chute = document.getElementById("eject-chute");
    const polaroid = document.getElementById("eject-polaroid");
    const veil = document.getElementById("develop-veil");
    const cont = document.getElementById("eject-continue");
    const cap = document.getElementById("eject-cap");
    const dateEl = document.getElementById("eject-date");
    const img = document.getElementById("eject-img");

    const entry = pendingEntry;
    if (dateEl && entry) dateEl.textContent = formatStamp(entry.dateISO);
    if (cap && entry) {
      cap.textContent = entry.caption || "今天的阿咪";
    }
    if (img && entry) img.src = entry.image || "assets/eject-cat.jpg";

    resetEjectScene();
    requestAnimationFrame(() => {
      cam.classList.add("is-ready");
      setTimeout(() => {
        playShutter();
        flash();
        const burst = document.getElementById("cam-flash-burst");
        if (burst) {
          burst.classList.remove("bang");
          void burst.offsetWidth;
          burst.classList.add("bang");
        }
        cam.classList.add("is-shooting");
        setTimeout(() => cam.classList.remove("is-shooting"), 300);
        setTimeout(() => {
          chute.classList.add("is-ejecting");
          polaroid.classList.add("is-ejecting");
          setTimeout(() => {
            veil.classList.add("is-clear");
            polaroid.classList.add("is-developed");
            commitPendingEntry();
            if (cont) cont.hidden = false;
          }, 900);
        }, 180);
      }, 380);
    });
  }

  function go(id) {
    clearTimeout(p2Timer);
    pageId = id;
    pages.forEach((p) => p.classList.toggle("is-on", p.dataset.page === id));
    history.replaceState(null, "", "#" + id);
    if (id === "p1") syncDraftUI();
    if (id === "p2") {
      runEjectAnimation();
      p2Timer = setTimeout(() => go("p3"), 5200);
    }
    if (id === "p3") buildCalendar();
    if (id === "j1") buildShelf();
    if (id === "t1") buildTheater();
    if (id === "j2") {
      renderJournal();
      requestAnimationFrame(() => {
        syncPageWidths();
        setJournalPane(0, false);
      });
    }
    if (id === "t2") {
      ensureWelcome();
      document.getElementById("chat-input")?.focus();
    }
    if (id === "m1") buildMemories();
    if (id === "j-todo") buildTodos();
  }

  /** 拍立得底文：最多 10 字短标题；全文进 entry.text */
  function clampTitle(s, max = 10) {
    const t = String(s || "")
      .replace(/[「」""''【】\[\]（）()]/g, "")
      .replace(/\s+/g, "")
      .trim();
    if (!t) return "";
    return t.length > max ? t.slice(0, max) : t;
  }

  function localTitleFromStory(text, pet) {
    const raw = String(text || "").replace(/\s+/g, " ").trim();
    if (!raw) return pet ? `${pet}的今天` : "今天的阿咪";
    if (raw.length <= 10) return clampTitle(raw);

    const scenes = [
      [/窗边|阳光|晒太阳|午后光/, pet ? `${pet}晒太阳` : "窗边晒太阳"],
      [/纸箱/, pet ? `${pet}钻纸箱` : "纸箱探险"],
      [/袋袋|零食|罐头|猫粮/, pet ? `${pet}要零食` : "零食时间"],
      [/下雨|雨天|避雨/, pet ? `雨天的${pet}` : "雨天躲猫猫"],
      [/睡觉|午睡|趴着|打盹/, pet ? `${pet}小憩` : "小憩一刻"],
      [/玩|玩具|逗猫/, pet ? `${pet}在玩` : "玩耍时光"],
      [/夜|夜里|书架/, pet ? `夜里的${pet}` : "夜间巡游"],
      [/体检|医院|打针/, pet ? `${pet}去体检` : "健康日记"],
    ];
    for (const [re, title] of scenes) {
      if (re.test(raw)) return clampTitle(title);
    }

    let clause = raw.split(/[，。！？、；\n,.!?]/)[0] || raw;
    clause = clause.replace(/^(今天|此刻|刚才|我觉得|我想|然后|其实|就是)/, "");
    if (pet && clause.startsWith(pet)) {
      // keep
    } else if (pet && clause.length >= 4 && !clause.includes(pet)) {
      const rest = clampTitle(clause, 10 - pet.length);
      if (rest) return clampTitle(pet + rest);
    }
    return clampTitle(clause, 10) || (pet ? `${pet}的今天` : "今天的阿咪");
  }

  function getLlmConfig() {
    try {
      const key = localStorage.getItem("ami_llm_key") || window.AMI_LLM_KEY || "";
      if (!key) return null;
      return {
        key,
        endpoint:
          localStorage.getItem("ami_llm_endpoint") ||
          window.AMI_LLM_ENDPOINT ||
          "https://api.openai.com/v1/chat/completions",
        model: localStorage.getItem("ami_llm_model") || window.AMI_LLM_MODEL || "gpt-4o-mini",
      };
    } catch {
      return null;
    }
  }

  async function llmTitleFromStory(text, pet) {
    const cfg = getLlmConfig();
    if (!cfg) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(cfg.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.key}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: cfg.model,
          temperature: 0.4,
          max_tokens: 40,
          messages: [
            {
              role: "system",
              content:
                "你是拍立得相册拟题助手。把宠物日记压成极短中文标题：不超过10个字，不要标点，不要引号，不要解释，只输出标题本身。",
            },
            {
              role: "user",
              content: `宠物名：${pet || "未知"}\n日记全文：${text}\n请输出短标题：`,
            },
          ],
        }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const out = data?.choices?.[0]?.message?.content || "";
      return clampTitle(out.split("\n")[0], 10) || null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function extractPolaroidTitle(text, pet) {
    const full = String(text || "").trim();
    if (!full) return pet ? `${pet}的今天` : "今天的阿咪";
    const fromLlm = await llmTitleFromStory(full, pet);
    if (fromLlm) return fromLlm;
    return localTitleFromStory(full, pet);
  }

  async function shoot() {
    const text = (document.getElementById("p1-text")?.value || "").trim();
    state.draft.text = text;
    const image = state.draft.image;
    if (!image && !text) {
      toast("先选一张图，或写一句再提交");
      return;
    }
    ensureAudio();

    const signals = ingestTextSignals(text, { fromEntry: false });
    let pet = guessPet(text);
    if (!pet && signals.names[0]) pet = signals.names[0];
    pet = resolvePetForEntry(text, pet);

    if (pet) {
      ensurePet(pet, { unlockTheater: true, addEntry: true, chars: text.length });
    }

    toast(text ? "正在拟短标题…" : "准备吐片…");
    const caption = text
      ? await extractPolaroidTitle(text, pet)
      : pet
        ? `${pet}的今天`
        : "今天的阿咪";

    if (signals.todoAdded) {
      toast(`标题「${caption}」· 已抽 ${signals.todoAdded} 条待办`);
    } else {
      toast(`短标题：${caption}`);
    }

    const iso = formatDateISO(new Date());
    pendingEntry = {
      id: "e-" + Date.now(),
      dateISO: iso,
      pet: pet || "",
      text: text || caption,
      caption,
      image: image || "assets/eject-cat.jpg",
      mediaType: state.draft.mediaType === "video" ? "video" : "image",
    };
    const now = new Date();
    state.calYear = now.getFullYear();
    state.calMonth = now.getMonth();
    saveState();
    buildShelf();
    buildTheater();
    go("p2");
  }

  async function onPickMedia(file) {
    if (!file) return;
    const isImage = file.type.startsWith("image/");
    const isVideo = file.type.startsWith("video/");
    if (!isImage && !isVideo) {
      toast("请选择照片或视频");
      return;
    }
    try {
      toast(isVideo ? "正在抽取视频封面…" : "显影处理中…");
      if (draftVideoUrl) {
        URL.revokeObjectURL(draftVideoUrl);
        draftVideoUrl = "";
      }
      if (isVideo) {
        const { cover, videoUrl } = await extractVideoCover(file);
        state.draft.image = cover;
        state.draft.mediaType = "video";
        draftVideoUrl = videoUrl;
        saveState();
        syncDraftUI();
        toast("视频已选 · 封面放入拍立得");
      } else {
        const dataUrl = await compressImage(file);
        state.draft.image = dataUrl;
        state.draft.mediaType = "image";
        saveState();
        syncDraftUI();
        toast("已放入拍立得");
      }
    } catch {
      toast(isVideo ? "视频读取失败，换一个试试" : "图片读取失败，换一张试试");
    }
  }

  let mediaRecorder = null;
  let mediaChunks = [];
  let voiceMode = "idle"; // idle | listening | recording

  function applyVoiceText(said) {
    const box = document.getElementById("p1-text");
    if (!box || !said) return;
    box.value = String(said).trim().slice(0, 120);
    state.draft.text = box.value;
    saveState();
    syncCaptionPh();
    document.querySelector(".caption-field")?.classList.add("is-filled", "is-focus");
    toast("已写入便签");
  }

  function setMicListening(on) {
    document.querySelector(".hit-mic")?.classList.toggle("is-listening", on);
  }

  function canUseSpeechRecognition() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    // 非安全上下文（如 http://局域网IP）多数手机浏览器会禁用
    if (!SR) return null;
    if (!window.isSecureContext && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") {
      return null;
    }
    return SR;
  }

  async function startVoiceInput() {
    const SR = canUseSpeechRecognition();

    // 已在录音：再点结束
    if (voiceMode === "recording" && mediaRecorder) {
      mediaRecorder.stop();
      return;
    }
    if (voiceMode === "listening") {
      toast("正在听，请继续说…");
      return;
    }

    // 1) 优先：浏览器语音识别（需 HTTPS / localhost）
    if (SR) {
      try {
        const rec = new SR();
        rec.lang = "zh-CN";
        rec.interimResults = false;
        rec.maxAlternatives = 1;
        rec.continuous = false;
        voiceMode = "listening";
        setMicListening(true);
        toast("请说话，说完会自动写入…");
        rec.onresult = (ev) => {
          const said = ev.results?.[0]?.[0]?.transcript?.trim();
          if (said) applyVoiceText(said);
          else toast("没听清，再试一次");
        };
        rec.onerror = (ev) => {
          const err = ev?.error || "";
          if (err === "not-allowed") toast("请允许麦克风权限后再试");
          else if (err === "no-speech") toast("没听到声音，再点一次");
          else toast("语音识别失败，可改用键盘语音");
        };
        rec.onend = () => {
          voiceMode = "idle";
          setMicListening(false);
        };
        rec.start();
        return;
      } catch {
        voiceMode = "idle";
        setMicListening(false);
      }
    }

    // 2) 降级：系统键盘语音（手机最稳）
    const box = document.getElementById("p1-text");
    if (box) {
      box.focus();
      document.querySelector(".caption-field")?.classList.add("is-focus", "is-ready");
      box.style.caretColor = "#2f3430";
    }

    // 3) 同时尝试录音附件（不依赖转写 API）
    if (!navigator.mediaDevices?.getUserMedia) {
      toast("请点输入框，用键盘上的麦克风说话");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaChunks = [];
      const mime = MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : MediaRecorder.isTypeSupported("audio/mp4")
          ? "audio/mp4"
          : "";
      mediaRecorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      mediaRecorder.ondataavailable = (e) => {
        if (e.data?.size) mediaChunks.push(e.data);
      };
      mediaRecorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        voiceMode = "idle";
        setMicListening(false);
        mediaRecorder = null;
        if (mediaChunks.length) {
          const blob = new Blob(mediaChunks, { type: mediaChunks[0].type || "audio/webm" });
          if (state.draft.audioUrl) URL.revokeObjectURL(state.draft.audioUrl);
          state.draft.audioUrl = URL.createObjectURL(blob);
          // 不进 localStorage（体积大）；会话内可回放
        }
        if (!box?.value.trim()) {
          toast("已录音 · 请在便签补文字（或用键盘麦克风转写）");
        } else {
          toast("已附加语音");
        }
      };
      mediaRecorder.start();
      voiceMode = "recording";
      setMicListening(true);
      toast("正在录音，再点音符结束 · 也可用键盘麦克风转写");
    } catch {
      toast("请允许麦克风，或点便签用键盘自带语音输入");
    }
  }

  let entryIndex = 0;
  let currentBookPet = "小橘";

  function petEntries() {
    return state.entries
      .filter((e) => e.pet === currentBookPet)
      .sort((a, b) => (a.dateISO < b.dateISO ? 1 : -1));
  }

  function entryStamp(e) {
    return Number(String(e?.id || "").replace(/\D/g, "")) || 0;
  }

  function entriesForDay(year, month, day) {
    const iso = `${year}-${pad2(month + 1)}-${pad2(day)}`;
    return state.entries
      .filter((e) => e.dateISO === iso)
      .sort((a, b) => entryStamp(b) - entryStamp(a));
  }

  function buildCalendar() {
    const grid = document.getElementById("cal-grid");
    const label = document.getElementById("cal-month-label");
    if (!grid) return;
    const y = state.calYear;
    const m = state.calMonth;
    if (label) label.textContent = `${y}年${m + 1}月`;

    const first = new Date(y, m, 1);
    const startCol = first.getDay();
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const cells = [];
    for (let i = 0; i < startCol; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) cells.push(d);
    while (cells.length % 7 !== 0) cells.push(null);
    while (cells.length < 35) cells.push(null);
    if (cells.length > 42) cells.length = 42;

    grid.style.gridTemplateRows = `repeat(${cells.length / 7}, 1fr)`;
    grid.innerHTML = "";
    cells.forEach((d) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cal-cell";
      if (!d) {
        btn.tabIndex = -1;
        btn.setAttribute("aria-hidden", "true");
        grid.appendChild(btn);
        return;
      }
      const num = document.createElement("span");
      num.className = "cal-day-num";
      num.textContent = String(d);
      btn.appendChild(num);

      const hits = entriesForDay(y, m, d);
      if (hits.length) {
        btn.classList.add("has-photo");
        if (hits.length > 1) btn.classList.add("has-multi");
        btn.dataset.act = "open-day";
        btn.dataset.day = String(d);
        btn.setAttribute(
          "aria-label",
          hits.length > 1
            ? `${m + 1}月${d}日 · ${hits.length}张`
            : `${m + 1}月${d}日打卡`
        );
        const stack = document.createElement("span");
        stack.className = "cal-stack";
        // 底层先画旧图露边，顶层最新主图
        const layers = hits.slice(0, 3).reverse();
        layers.forEach((hit, i) => {
          const depth = layers.length - 1 - i;
          const polaroid = document.createElement("span");
          polaroid.className = `cal-polaroid cal-polaroid--d${Math.min(depth, 2)}`;
          polaroid.innerHTML =
            depth === 0
              ? `<span class="cal-polaroid-tape" aria-hidden="true"></span><span class="cal-polaroid-pic"></span>`
              : `<span class="cal-polaroid-pic"></span>`;
          polaroid.querySelector(".cal-polaroid-pic").style.backgroundImage =
            `url("${thumbUrl(hit.image)}")`;
          stack.appendChild(polaroid);
        });
        btn.appendChild(stack);
      } else {
        btn.tabIndex = -1;
      }
      grid.appendChild(btn);
    });
  }

  function shiftMonth(dir) {
    const dt = new Date(state.calYear, state.calMonth + dir, 1);
    state.calYear = dt.getFullYear();
    state.calMonth = dt.getMonth();
    saveState();
    buildCalendar();
    toast(`${state.calYear}年${state.calMonth + 1}月`);
  }

  let dayHits = [];
  let dayHitIndex = 0;
  let dayOpenNum = 0;
  let dayDidSwipe = false;

  function clearDayVideo() {
    const v = document.getElementById("day-modal-video");
    if (v) {
      v.pause();
      v.remove();
    }
    const imgEl = document.getElementById("day-modal-img");
    if (imgEl) imgEl.hidden = false;
  }

  function closeDayModal() {
    const flip = document.getElementById("day-flip");
    flip?.classList.remove("is-flipped");
    clearDayVideo();
    dayHits = [];
    dayHitIndex = 0;
    if (dayModal) dayModal.hidden = true;
  }

  function dayTipText(flipped) {
    if (flipped) return "轻触翻回正面";
    if (dayHits.length > 1) {
      return `左右滑动换图（${dayHitIndex + 1}/${dayHits.length}）· 轻触翻面`;
    }
    return "轻触照片翻面看故事";
  }

  function syncDayChrome(flipped) {
    const tip = document.getElementById("day-flip-tip");
    const count = document.getElementById("day-count");
    const prev = document.getElementById("day-nav-prev");
    const next = document.getElementById("day-nav-next");
    const multi = dayHits.length > 1;
    if (tip) tip.textContent = dayTipText(flipped);
    if (count) {
      count.hidden = !multi;
      count.textContent = `${dayHitIndex + 1} / ${dayHits.length}`;
    }
    // 用 invisible class 占位，避免 display:none 把中间卡片挤没
    if (prev) {
      prev.hidden = false;
      prev.classList.toggle("is-invisible", !multi);
      prev.disabled = !multi;
      prev.setAttribute("aria-hidden", multi ? "false" : "true");
    }
    if (next) {
      next.hidden = false;
      next.classList.toggle("is-invisible", !multi);
      next.disabled = !multi;
      next.setAttribute("aria-hidden", multi ? "false" : "true");
    }
  }

  function renderDayEntry() {
    const e = dayHits[dayHitIndex];
    if (!e) return;
    const flip = document.getElementById("day-flip");
    const img = document.getElementById("day-modal-img");
    const cap = document.getElementById("day-modal-cap");
    const meta = document.getElementById("day-modal-meta");
    const story = document.getElementById("day-modal-story");
    flip?.classList.remove("is-flipped");
    clearDayVideo();

    const title = e.caption || "今天的阿咪";
    const body = (e.text || "").trim() || title;
    const metaLine = `${state.calMonth + 1}月${dayOpenNum}日${e.pet ? " · " + e.pet : ""}`;

    if (cap) cap.textContent = title;
    if (meta) meta.textContent = metaLine;
    if (story) {
      story.textContent = body;
      story.scrollTop = 0;
    }

    const sessionUrl = sessionVideos.get(e.id);
    const picWrap = img?.parentElement;
    if (e.mediaType === "video" && sessionUrl && picWrap) {
      if (img) img.hidden = true;
      const videoEl = document.createElement("video");
      videoEl.id = "day-modal-video";
      videoEl.src = sessionUrl;
      videoEl.controls = true;
      videoEl.playsInline = true;
      videoEl.setAttribute("playsinline", "true");
      picWrap.appendChild(videoEl);
    } else if (img) {
      img.hidden = false;
      img.src = thumbUrl(e.image);
    }

    syncDayChrome(false);
  }

  function shiftDayEntry(dir) {
    if (dayHits.length <= 1) return;
    dayHitIndex = (dayHitIndex + dir + dayHits.length) % dayHits.length;
    renderDayEntry();
  }

  async function openDay(d) {
    const hits = entriesForDay(state.calYear, state.calMonth, d);
    if (!hits.length) {
      toast("这一天还没有照片");
      return;
    }
    dayHits = hits;
    dayHitIndex = 0;
    dayOpenNum = d;
    if (dayModal) dayModal.hidden = false;
    // 先画出卡片骨架，再补图，避免空白态
    renderDayEntry();
    await Promise.all(hits.map((e) => ensureEntryImage(e)));
    renderDayEntry();
  }

  function toggleDayFlip(e) {
    if (dayDidSwipe) {
      dayDidSwipe = false;
      return;
    }
    // 背面滚动文字时不触发翻面
    if (e.target.closest(".day-story")) return;
    if (e.target.closest("video, .flip-close, .day-nav")) return;
    const flip = document.getElementById("day-flip");
    if (!flip) return;
    flip.classList.toggle("is-flipped");
    syncDayChrome(flip.classList.contains("is-flipped"));
  }

  function bindDaySwipe() {
    const stage = document.querySelector("#day-modal .flip-stage");
    if (!stage || stage.dataset.swipeBound) return;
    stage.dataset.swipeBound = "1";
    let startX = 0;
    let startY = 0;
    let tracking = false;

    stage.addEventListener(
      "pointerdown",
      (e) => {
        if (e.target.closest("video, .day-story, .flip-close, .day-nav")) return;
        tracking = true;
        startX = e.clientX;
        startY = e.clientY;
      },
      { passive: true }
    );

    stage.addEventListener(
      "pointerup",
      (e) => {
        if (!tracking) return;
        tracking = false;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.15) {
          dayDidSwipe = true;
          shiftDayEntry(dx < 0 ? 1 : -1);
        }
      },
      { passive: true }
    );

    stage.addEventListener("pointercancel", () => {
      tracking = false;
    });
  }

  const viewport = document.getElementById("journal-viewport");
  const track = document.getElementById("journal-track");
  let pane = 0;
  let dragX = 0;
  let startX = 0;
  let dragging = false;

  function pageWidth() {
    return viewport?.clientWidth || window.innerWidth;
  }

  function syncPageWidths() {
    const w = pageWidth();
    document.documentElement.style.setProperty("--j-page-w", w + "px");
    const left = document.getElementById("j-left");
    const right = document.getElementById("j-right");
    if (left) left.style.width = w + "px";
    if (right) right.style.width = w + "px";
  }

  function setJournalPane(next, animate = true) {
    pane = next <= 0 ? 0 : 1;
    syncPageWidths();
    const w = pageWidth();
    const peek = pane === 0 ? 12 : 0;
    const x = -pane * w - peek;
    if (!animate) track.classList.add("dragging");
    track.style.transform = `translateX(${x}px)`;
    if (!animate) {
      void track.offsetWidth;
      track.classList.remove("dragging");
    }
  }

  function renderJournal() {
    const list = petEntries();
    const tag = document.getElementById("j-pet-tag");
    if (tag) tag.textContent = currentBookPet;
    if (!list.length) {
      document.getElementById("j-date").textContent = "暂无条目";
      document.getElementById("j-body").textContent = "这本还是空的，去记一点关于它的故事吧。";
      document.getElementById("j-photos").innerHTML = "";
      return;
    }
    if (entryIndex >= list.length) entryIndex = 0;
    const e = list[entryIndex];
    document.getElementById("j-date").textContent = formatJournalDate(e.dateISO);
    document.getElementById("j-body").textContent = e.text;
    const photos = document.getElementById("j-photos");
    photos.innerHTML = `<figure><img src="${e.image}" alt="" /><figcaption>${e.caption || ""}</figcaption></figure>`;
  }

  function flipJournal(dir) {
    const list = petEntries();
    if (!list.length) return;
    entryIndex = (entryIndex + dir + list.length) % list.length;
    track.classList.add("dragging");
    const w = pageWidth();
    track.style.transform = `translateX(${dir > 0 ? -w * 1.15 : w * 0.15}px)`;
    setTimeout(() => {
      renderJournal();
      setJournalPane(0, false);
      toast(list[entryIndex].dateISO.slice(5).replace("-", "/"));
    }, 160);
  }

  function openBook(bookId) {
    if (shelfManaging && bookId !== "todo") {
      toast("管理中：请用改名/删除，或先点「完成管理」");
      return;
    }
    if (bookId === "todo") {
      buildTodos();
      go("j-todo");
      return;
    }
    if (!findPetByName(bookId)) {
      toast("这本还不存在");
      return;
    }
    currentBookPet = bookId;
    entryIndex = 0;
    go("j2");
  }

  function buildTodos() {
    const list = document.getElementById("todo-list");
    if (!list) return;
    list.innerHTML = "";
    state.todos.filter((t) => !t.done).forEach((t) => {
      const li = document.createElement("li");
      li.className = "todo-item";
      li.dataset.id = t.id;
      li.innerHTML = `
        <button type="button" class="todo-check" aria-label="完成"></button>
        <div class="todo-body">
          <p>${t.text}</p>
          <small>${t.source || "手动添加"}</small>
        </div>`;
      li.querySelector(".todo-check").addEventListener("click", () => completeTodo(li, t.id));
      list.appendChild(li);
    });
  }

  function completeTodo(li, id) {
    if (li.classList.contains("is-checked")) return;
    li.querySelector(".todo-check").classList.add("is-on");
    li.classList.add("is-checked");
    setTimeout(() => {
      li.classList.add("is-done");
      setTimeout(() => {
        const item = state.todos.find((t) => t.id === id);
        if (item) item.done = true;
        saveState();
        li.remove();
        // 若待办清空且从未有宠物本，书架会变空；有历史待办仍保留本子
        buildShelf();
      }, 480);
    }, 420);
  }

  function addTodo(text) {
    const t = text.trim();
    if (!t) return;
    state.todos.unshift({
      id: "t-" + Date.now(),
      text: t,
      source: "手动添加",
      done: false,
    });
    saveState();
    buildTodos();
    buildShelf();
  }

  function onPointerDown(e) {
    if (pageId !== "j2") return;
    if (e.target.closest("button, a, input, textarea")) return;
    dragging = true;
    startX = e.clientX ?? e.touches?.[0]?.clientX ?? 0;
    dragX = 0;
    track.classList.add("dragging");
  }
  function onPointerMove(e) {
    if (!dragging) return;
    const x = e.clientX ?? e.touches?.[0]?.clientX ?? 0;
    dragX = x - startX;
    const w = pageWidth();
    const peek = pane === 0 ? 12 : 0;
    const base = -pane * w - peek;
    const minX = -w - 24;
    const maxX = 24;
    const next = Math.min(maxX, Math.max(minX, base + dragX));
    track.style.transform = `translateX(${next}px)`;
  }
  function onPointerUp() {
    if (!dragging) return;
    dragging = false;
    track.classList.remove("dragging");
    const threshold = Math.min(64, pageWidth() * 0.18);
    if (dragX < -threshold) setJournalPane(1, true);
    else if (dragX > threshold) setJournalPane(0, true);
    else setJournalPane(pane, true);
    dragX = 0;
  }

  viewport?.addEventListener("mousedown", onPointerDown);
  window.addEventListener("mousemove", onPointerMove);
  window.addEventListener("mouseup", onPointerUp);
  viewport?.addEventListener("touchstart", onPointerDown, { passive: true });
  viewport?.addEventListener("touchmove", (e) => {
    if (!dragging) return;
    onPointerMove(e);
  }, { passive: true });
  viewport?.addEventListener("touchend", onPointerUp);
  window.addEventListener("resize", () => {
    if (pageId === "j2") setJournalPane(pane, false);
  });

  const chatLog = document.getElementById("chat-log");
  let currentPetId = "小橘";
  let welcomedFor = null;

  const PETS = {
    小橘: {
      welcome: () => "……嗯？你来啦。窗边还有一点太阳，我先不起来。",
      replies: [
        (traits, msg) => `（小橘）\n你说「${clip(msg)}」……我听着。不过阳光更好，再趴五分钟。`,
        (traits) => `（按角色卡：${traits}）\n唔。你要是坐过来，我可以把尾巴借给你当手链。`,
        () => "（小橘打了个哈欠）\n今天的云，像猫砂盆里的山。",
      ],
    },
    小花: {
      welcome: () => "喵！袋子呢？……哦，是你。那也行，你身上有没有纸箱味？",
      replies: [
        (traits, msg) => `（小花）\n「${clip(msg)}」？听起来像新玩具。我去瞧瞧——哗啦！`,
        (traits) => `（按角色卡：${traits}）\n别藏零食。我闻得到。现在。立刻。`,
        () => "（小花绕着你转圈）\n今天适合拆一卷纸，或者……拆你的注意力。",
      ],
    },
    小黑: {
      welcome: () => "……。\n（它看了你一眼，又把脸埋回阴影里。下巴朝你抬了一下。）",
      replies: [
        (traits, msg) => `（小黑）\n「${clip(msg)}」。收到。\n别摸背。下巴可以。`,
        (traits) => `（按角色卡：${traits}）\n夜里我才会认真聊天。现在……勉强陪你三句。`,
        () => "（小黑跳上书架）\n你们白天太吵。我在上面听。",
      ],
    },
    _default: {
      welcome: (name) => `（${name}歪了歪头）\n你来啦。我还在学着了解自己。`,
      replies: [
        (traits, msg, name) =>
          `（${name}）\n「${clip(msg)}」……我记住了。${traits ? `\n（按角色卡：${traits}）` : ""}`,
        (traits, msg, name) => `（${name}轻轻蹭了蹭你）\n再说一点今天的事给我听吧。`,
        (traits, msg, name) => `（${name}）\n嗯。有你在就好。`,
      ],
    },
  };

  function clip(s, n = 12) {
    const t = String(s || "").trim();
    return t.length > n ? t.slice(0, n) + "…" : t || "……";
  }

  function selectPet(petId) {
    if (theaterManaging) {
      toast("管理中：请先点「完成管理」");
      return;
    }
    const pet = findPetByName(petId) || state.pets[0];
    if (!pet) {
      toast("还没有角色卡，先新建一个吧");
      go("t1");
      return;
    }
    currentPetId = pet.name;
    const ready = isPetReady(pet);
    const pageChat = document.querySelector(".page-chat");
    pageChat?.classList.toggle("is-lowinfo", !ready);

    document.getElementById("chat-pet").textContent = currentPetId;
    document.getElementById("card-pet-name").textContent = currentPetId;
    const traitBox = document.getElementById("trait-text");
    const warn = document.getElementById("trait-warn");
    if (warn) {
      warn.hidden = false;
      warn.textContent = ready
        ? "已有一定素材，可以试着聊聊；你仍可改上方角色卡。"
        : "可以先建卡、先进来看看。目前收集的信息还不够，还不能够进行比较好的交互——多记几篇日记后，性格会慢慢清晰。";
      warn.style.background = ready ? "#e8f2ea" : "#f3ebe0";
      warn.style.color = ready ? "#4d6b55" : "#6a5e4e";
    }
    if (traitBox) {
      traitBox.value = pet.traits || "";
      traitBox.placeholder = ready
        ? "性格摘要，可随时改…"
        : "可先留空；有素材后会更准，也可自己先写几句";
    }
    document.getElementById("chat-input").placeholder = ready
      ? `跟${currentPetId}说点什么…`
      : "先聊聊也行，完整互动还要再等等…";
    syncChatHeroAvatar(pet);
    chatLog.innerHTML = "";
    welcomedFor = null;
    go("t2");
    requestAnimationFrame(() => {
      const sc = document.getElementById("chat-scroll");
      if (sc) sc.scrollTop = 0;
    });
  }

  function ensureWelcome() {
    if (welcomedFor === currentPetId) return;
    welcomedFor = currentPetId;
    const pet = findPetByName(currentPetId);
    const ready = isPetReady(pet);
    if (!ready) {
      addPetBubble(
        `（${currentPetId}歪了歪头）\n角色卡可以先建好，但我还不太了解自己。\n目前收集的信息还不够，还不能够进行比较好的交互。\n你多记几篇关于我的日记，互动会慢慢像样起来。`
      );
      return;
    }
    const pack = PETS[currentPetId] || PETS._default;
    addPetBubble(pack.welcome(currentPetId));
  }

  function addPetBubble(text) {
    const wrap = document.createElement("div");
    wrap.className = "bubble pet";
    wrap.dataset.pet = currentPetId;
    wrap.innerHTML = `<div>${text.replace(/\n/g, "<br>")}</div>
      <div class="bubble-actions">
        <button type="button" data-fb="like">喜欢</button>
        <button type="button" data-fb="dislike">不喜欢</button>
      </div>`;
    chatLog.appendChild(wrap);
    chatLog.scrollTop = chatLog.scrollHeight;
    const sc = document.getElementById("chat-scroll");
    if (sc) sc.scrollTop = sc.scrollHeight;
    wrap.querySelectorAll("[data-fb]").forEach((btn) => {
      btn.addEventListener("click", () => {
        wrap.querySelectorAll("[data-fb]").forEach((b) => b.classList.remove("is-on"));
        btn.classList.add("is-on");
        if (btn.dataset.fb === "like") toast(`${currentPetId}：已记录喜欢`);
        else toast(`${currentPetId}：已点踩 · 可改角色卡`);
      });
    });
  }

  function sendChat() {
    const input = document.getElementById("chat-input");
    const text = input.value.trim();
    if (!text) {
      input.focus();
      return;
    }
    const me = document.createElement("div");
    me.className = "bubble me";
    me.textContent = text;
    chatLog.appendChild(me);
    input.value = "";
    input.focus();
    const sc = document.getElementById("chat-scroll");
    if (sc) sc.scrollTop = sc.scrollHeight;

    const petRec = findPetByName(currentPetId);
    const ready = isPetReady(petRec);
    if (!ready) {
      setTimeout(
        () =>
          addPetBubble(
            `（${currentPetId}）\n目前收集的信息还不够，还不能够进行比较好的交互。\n你多记几篇带我名字的日记，我会慢慢清楚起来。`
          ),
        420
      );
      return;
    }

    const pack = PETS[currentPetId] || PETS._default;
    const traits =
      document.getElementById("trait-text").value.trim() || petRec?.traits || "";
    if (petRec) {
      petRec.traits = traits;
      saveState();
    }
    const replyFn = pack.replies[Math.floor(Math.random() * pack.replies.length)];
    setTimeout(() => addPetBubble(replyFn(traits, text, currentPetId)), 420);
  }

  function buildMemories() {
    const rail = document.getElementById("mem-rail");
    const dots = document.getElementById("mem-dots");
    if (!rail || !dots) return;
    const withPhoto = state.entries.filter((e) => e.image);
    if (!withPhoto.length) {
      rail.innerHTML = `<article class="mem-slide"><div class="mem-polaroid"><p style="padding:40px 16px;text-align:center;color:#6b736c">还没有可回顾的照片<br/>去记一张吧</p></div></article>`;
      dots.innerHTML = "";
      const title = document.getElementById("mem-title");
      if (title) title.textContent = "精选回顾";
      return;
    }
    const slides = withPhoto.slice(0, 12).map((e) => ({
      src: e.image,
      title: e.caption || formatJournalDate(e.dateISO),
      cap: `${e.pet || "日记"} · ${e.dateISO.slice(5)}`,
    }));

    rail.innerHTML = slides
      .map(
        (s) => `<article class="mem-slide" data-title="${s.title}">
          <div class="mem-polaroid">
            <img src="${s.src}" alt="${s.cap}" draggable="false" />
            <p>${s.cap}</p>
          </div>
        </article>`
      )
      .join("");
    dots.innerHTML = slides.map((_, i) => `<span${i === 0 ? ' class="is-on"' : ""}></span>`).join("");

    const title = document.getElementById("mem-title");
    let memIndex = 0;
    const sync = () => {
      const w = rail.clientWidth || 1;
      const idx = Math.round(rail.scrollLeft / w);
      memIndex = Math.max(0, Math.min(slides.length - 1, idx));
      if (title) title.textContent = slides[memIndex].title;
      [...dots.children].forEach((d, i) => d.classList.toggle("is-on", i === memIndex));
    };
    const goMem = (i) => {
      memIndex = Math.max(0, Math.min(slides.length - 1, i));
      rail.scrollTo({ left: memIndex * rail.clientWidth, behavior: "smooth" });
      sync();
    };
    rail.onscroll = sync;
    dots.onclick = (e) => {
      const span = e.target.closest("span");
      if (!span) return;
      goMem([...dots.children].indexOf(span));
    };
    let memDragging = false;
    let memStartX = 0;
    let memStartLeft = 0;
    rail.onpointerdown = (e) => {
      if (e.pointerType === "touch") return;
      memDragging = true;
      memStartX = e.clientX;
      memStartLeft = rail.scrollLeft;
      rail.setPointerCapture(e.pointerId);
      rail.style.scrollBehavior = "auto";
    };
    rail.onpointermove = (e) => {
      if (!memDragging) return;
      rail.scrollLeft = memStartLeft - (e.clientX - memStartX);
    };
    const endDrag = (e) => {
      if (!memDragging) return;
      memDragging = false;
      rail.style.scrollBehavior = "smooth";
      const w = rail.clientWidth || 1;
      const dx = e.clientX - memStartX;
      if (Math.abs(dx) > 40) goMem(memIndex + (dx < 0 ? 1 : -1));
      else goMem(Math.round(rail.scrollLeft / w));
    };
    rail.onpointerup = endDrag;
    rail.onpointercancel = endDrag;
    requestAnimationFrame(() => {
      rail.scrollLeft = 0;
      sync();
    });
  }

  app.addEventListener("click", (e) => {
    const t = e.target.closest("[data-act]");
    if (!t) return;
    const act = t.dataset.act;
    switch (act) {
      case "go":
        go(t.dataset.to);
        break;
      case "shoot":
        shoot();
        break;
      case "pick-photo":
        document.getElementById("p1-file")?.click();
        break;
      case "voice-input":
        startVoiceInput();
        break;
      case "month-prev":
        shiftMonth(-1);
        break;
      case "month-next":
        shiftMonth(1);
        break;
      case "toast":
        toast(t.dataset.msg || "");
        break;
      case "pick-pet":
        selectPet(t.dataset.pet);
        break;
      case "send-chat":
        sendChat();
        break;
      case "journal-prev":
        flipJournal(-1);
        break;
      case "journal-next":
        flipJournal(1);
        break;
      case "close-modal":
        closeDayModal();
        break;
      case "open-day":
        openDay(Number(t.dataset.day));
        break;
      case "day-prev":
        shiftDayEntry(-1);
        break;
      case "day-next":
        shiftDayEntry(1);
        break;
      case "open-book":
        openBook(t.dataset.book);
        break;
      case "pet-avatar":
        pickPetAvatar(t.dataset.pet);
        break;
      case "theater-add":
        addTheaterCard();
        break;
      case "theater-manage":
        toggleTheaterManage();
        break;
      case "shelf-add":
        addPetBook();
        break;
      case "shelf-manage":
        toggleShelfManage();
        break;
      case "delete-pet":
        deletePetBook(t.dataset.pet);
        break;
      case "rename-pet":
        askRename(t.dataset.pet || currentBookPet);
        break;
      default:
        break;
    }
  });

  document.getElementById("p1-file")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) await onPickMedia(file);
  });

  document.getElementById("theater-avatar-file")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) await onTheaterAvatarFile(file);
  });

  document.getElementById("todo-add")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const input = document.getElementById("todo-input");
    addTodo(input?.value || "");
    if (input) input.value = "";
  });

  document.getElementById("trait-text")?.addEventListener("change", () => {
    const v = document.getElementById("trait-text").value.trim();
    const pet = findPetByName(currentPetId);
    if (!pet) return;
    pet.traits = v;
    saveState();
    toast("角色卡已保存");
  });

  document.getElementById("chat-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      sendChat();
    }
  });

  dayModal?.addEventListener("click", (e) => {
    if (e.target === dayModal) closeDayModal();
  });
  document.getElementById("day-flip")?.addEventListener("click", toggleDayFlip);
  bindDaySwipe();

  const p1Text = document.getElementById("p1-text");
  const p1Field = document.querySelector(".caption-field");
  let captionReadyTimer;

  function syncCaptionPh() {
    const filled = Boolean(p1Text?.value.trim());
    p1Field?.classList.toggle("is-filled", filled);
    if (filled) {
      p1Field?.classList.add("is-ready");
      if (p1Text) p1Text.style.caretColor = "#2f3430";
    }
  }

  p1Text?.addEventListener("focus", () => {
    p1Field?.classList.add("is-focus");
    p1Field?.classList.remove("is-ready");
    clearTimeout(captionReadyTimer);
    captionReadyTimer = setTimeout(() => {
      if (!p1Text.value.trim()) {
        p1Field?.classList.add("is-ready");
        p1Text.style.caretColor = "#2f3430";
      }
    }, 140);
  });

  p1Text?.addEventListener("blur", () => {
    clearTimeout(captionReadyTimer);
    p1Field?.classList.remove("is-focus", "is-ready");
    if (!p1Text.value.trim()) p1Text.style.caretColor = "transparent";
    state.draft.text = p1Text.value.trim();
    saveState();
    syncCaptionPh();
  });

  p1Text?.addEventListener("input", () => {
    state.draft.text = p1Text.value;
    syncCaptionPh();
  });
  p1Text?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") e.preventDefault();
  });

  // 月历默认对齐「今天」所在月
  {
    const now = new Date();
    if (state.calYear == null) state.calYear = now.getFullYear();
    if (state.calMonth == null) state.calMonth = now.getMonth();
  }

  buildCalendar();
  syncDraftUI();
  buildShelf();
  buildTheater();
  hydrateBlobs().catch(() => {});
  go("p1");
})();
