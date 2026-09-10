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
  let cropSourceUrl = ""; // 未裁切原图，供调整取景
  let cropPendingMediaType = "image";
  let cropPendingVideoUrl = "";
  let cropSession = null;

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
      id: "seed-0520",
      dateISO: "2026-05-20",
      pet: "小橘",
      text: "小橘和小花今天一起玩疯了，互相追着跑，最后依偎在窗边一起晒太阳。",
      caption: "两只一起玩",
      image: "assets/ami-memories.png",
    },
    {
      id: "seed-0522",
      dateISO: "2026-05-22",
      pet: "小橘",
      text: "小橘和小黑又打架了，互相咬着抢地盘，吵完小橘一整天都不想理小黑。",
      caption: "又掐架了",
      image: "assets/ami-theater-select.png",
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
      relations: [], // { a, b, score, good, bad, evidence: string[] }
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
    if (!jobs.length) return { ok: true, count: 0 };
    const results = await Promise.allSettled(jobs);
    const failed = results.filter((r) => r.status === "rejected").length;
    return { ok: failed === 0, count: results.length - failed, failed };
  }

  function slimEntriesForStorage(entries) {
    return (entries || []).map((e) => {
      const img = String(e.image || "");
      let image = img;
      if (img.startsWith("data:") && e.id) image = blobRef("entry", e.id);
      return { ...e, image };
    });
  }

  function slimPetsForStorage(pets) {
    return (pets || []).map((p) => {
      const av = String(p.avatar || "");
      let avatar = av;
      if (av.startsWith("data:")) avatar = blobRef("pet", p.id || p.name);
      return { ...p, avatar };
    });
  }

  async function hydrateBlobs() {
    let changed = false;
    let missing = 0;
    for (const e of state.entries) {
      const ref = parseBlobRef(e.image);
      const needs =
        ref ||
        (e?.id &&
          (!e.image ||
            e.image === "assets/eject-cat.jpg" ||
            String(e.image).startsWith("__blob__:")));
      if (!needs && e?.id && !isUsableImage(e.image) && !String(e.image || "").startsWith("assets/")) {
        // try recover by id
      }
      if (ref || (e?.id && (!isUsableImage(e.image) || e.image === "assets/eject-cat.jpg"))) {
        const key = ref ? `${ref.kind}:${ref.id}` : `entry:${e.id}`;
        try {
          const data = await idbGet(key);
          if (data) {
            e.image = data;
            changed = true;
          } else if (ref || String(e.image || "").startsWith("__blob__:")) {
            missing += 1;
          }
        } catch {
          /* ignore */
        }
      }
    }
    for (const p of state.pets) {
      const ref = parseBlobRef(p.avatar);
      const key = p.id || p.name;
      if (ref || (key && !isUsableImage(p.avatar) && p.avatar)) {
        const idbKey = ref ? `${ref.kind}:${ref.id}` : `pet:${key}`;
        try {
          const data = await idbGet(idbKey);
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
    return { changed, missing };
  }

  function savePetsBackup() {
    try {
      localStorage.setItem(PETS_KEY, JSON.stringify(slimPetsForStorage(state.pets)));
      return true;
    } catch {
      return false;
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
        relations: Array.isArray(parsed.relations) ? parsed.relations : [],
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
  let saveChain = Promise.resolve();

  function saveState() {
    // 串行落盘：先把大图写入 IndexedDB，再把轻量元数据写入 localStorage
    saveChain = saveChain
      .catch(() => {})
      .then(() => saveStateAsync());
    return saveChain;
  }

  async function saveStateAsync() {
    savePetsBackup();

    const draftSafe = {
      text: state.draft.text || "",
      image: "",
      pet: state.draft.pet || "",
      mediaType: state.draft.mediaType || "image",
    };

    // 先确保持久化大图，避免关机/刷新时只剩文字引用
    const blobResult = await persistBlobs();

    const slimEntries = slimEntriesForStorage(state.entries);
    const slimPets = slimPetsForStorage(state.pets);

    const write = (entries, pets) => {
      localStorage.setItem(
        STORE_KEY,
        JSON.stringify({
          entries,
          todos: state.todos,
          pets,
          relations: state.relations || [],
          draft: draftSafe,
          calYear: state.calYear,
          calMonth: state.calMonth,
        })
      );
    };

    try {
      write(slimEntries, slimPets);
      if (blobResult && blobResult.failed) {
        toast("部分照片写入本机失败，建议立刻「导出备份」");
      }
      return true;
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
        toast("存储紧张：已保住文字与角色，照片请导出备份");
        return false;
      } catch {
        toast("本机存储不足，请先导出备份再清理");
        return false;
      }
    }
  }

  async function requestPersistentStorage() {
    try {
      if (!navigator.storage || !navigator.storage.persist) return false;
      const already = await navigator.storage.persisted();
      if (already) return true;
      return await navigator.storage.persist();
    } catch {
      return false;
    }
  }

  async function exportLocalBackup() {
    toast("正在打包本机备份…");
    await saveState();
    await hydrateBlobs();
    const payload = {
      version: 1,
      app: "ami-diary",
      exportedAt: new Date().toISOString(),
      origin: location.origin,
      state: {
        entries: state.entries.map((e) => ({ ...e })),
        todos: state.todos,
        pets: state.pets.map((p) => ({ ...p })),
        relations: state.relations || [],
        calYear: state.calYear,
        calMonth: state.calMonth,
      },
    };
    const text = JSON.stringify(payload);
    const day = formatDateISO(new Date());
    const filename = `ami-diary-backup-${day}.json`;
    const file = new File([text], filename, { type: "application/json" });

    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({
          files: [file],
          title: "阿咪日记备份",
          text: "本机备份，可导入恢复，不花云费",
        });
        toast("请把备份存到「文件」或发到电脑");
        return;
      }
    } catch (err) {
      if (err && err.name === "AbortError") return;
    }

    const url = URL.createObjectURL(file);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast("备份已保存到本机 · 无云费用");
  }

  async function importLocalBackupFile(file) {
    if (!file) return;
    try {
      toast("正在导入备份…");
      const text = await file.text();
      const data = JSON.parse(text);
      const incoming = data?.state || data;
      if (!incoming || !Array.isArray(incoming.entries)) {
        toast("备份文件格式不对");
        return;
      }
      const ok = window.confirm(
        "导入会覆盖当前这台设备上的阿咪日记（日记/待办/角色）。建议先点「导出」。确定导入吗？"
      );
      if (!ok) return;

      state.entries = incoming.entries.map((e) => ({ ...e }));
      state.todos = Array.isArray(incoming.todos) ? incoming.todos : [];
      state.pets = Array.isArray(incoming.pets) ? incoming.pets : [];
      state.relations = Array.isArray(incoming.relations) ? incoming.relations : [];
      if (incoming.calYear != null) state.calYear = incoming.calYear;
      if (incoming.calMonth != null) state.calMonth = incoming.calMonth;

      // 把导入的大图写入 IDB
      await persistBlobs();
      await saveState();
      await hydrateBlobs();
      ensureTodoDefaults();
      rebuildRelationsFromDiary();
      buildCalendar();
      buildShelf();
      buildTheater();
      syncDraftUI();
      toast(`已导入 ${state.entries.length} 条日记 · 已写入本机`);
    } catch (err) {
      console.warn("[ami] import fail", err);
      toast("导入失败，请换一份备份文件");
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

  const BGM_VOL = 0.18;
  const BGM_MUTE_KEY = "ami_bgm_muted";
  let bgmWantOn = true;
  let bgmUnlockBound = false;

  function bgmEl() {
    return document.getElementById("bgm-audio");
  }

  function bgmBtn() {
    return document.getElementById("bgm-toggle");
  }

  function readBgmMuted() {
    try {
      return localStorage.getItem(BGM_MUTE_KEY) === "1";
    } catch {
      return false;
    }
  }

  function writeBgmMuted(muted) {
    try {
      localStorage.setItem(BGM_MUTE_KEY, muted ? "1" : "0");
    } catch {
      /* ignore */
    }
  }

  function syncBgmButton() {
    const btn = bgmBtn();
    if (!btn) return;
    // 按用户意图显示：默认开；仅手动关闭才显示划掉
    const muted = !bgmWantOn;
    btn.classList.toggle("is-muted", muted);
    btn.classList.toggle("is-on", !muted);
    btn.setAttribute("aria-pressed", muted ? "false" : "true");
    btn.title = muted ? "点击开启背景音乐" : "点击关闭背景音乐";
  }

  async function playBgm() {
    const audio = bgmEl();
    if (!audio || !bgmWantOn) {
      syncBgmButton();
      return false;
    }
    audio.loop = true;
    try {
      ensureAudio();
      // 先静音 play，提高自动播放成功率，再恢复音量
      audio.muted = true;
      audio.volume = BGM_VOL;
      await audio.play();
      audio.muted = false;
      audio.volume = 0.02;
      const target = BGM_VOL;
      const steps = 10;
      for (let i = 1; i <= steps; i++) {
        await new Promise((r) => setTimeout(r, 35));
        if (!bgmWantOn || audio.paused) break;
        audio.volume = (target * i) / steps;
      }
      if (bgmWantOn && !audio.paused) {
        audio.muted = false;
        audio.volume = target;
      }
      syncBgmButton();
      return !audio.paused;
    } catch {
      try {
        audio.muted = false;
        audio.volume = BGM_VOL;
        await audio.play();
        syncBgmButton();
        return !audio.paused;
      } catch {
        syncBgmButton();
        return false;
      }
    }
  }

  function pauseBgm() {
    const audio = bgmEl();
    if (audio) {
      audio.pause();
      audio.muted = false;
    }
    syncBgmButton();
  }

  function toggleBgm() {
    if (bgmWantOn && bgmEl() && !bgmEl().paused) {
      bgmWantOn = false;
      writeBgmMuted(true);
      pauseBgm();
      toast("背景音乐已关闭");
      return;
    }
    bgmWantOn = true;
    writeBgmMuted(false);
    syncBgmButton();
    playBgm().then((ok) => {
      if (!ok) toast("点一下屏幕任意处即可开始播放");
      else toast("背景音乐已开启");
    });
  }

  function bindBgmUnlockOnce() {
    if (bgmUnlockBound) return;
    bgmUnlockBound = true;
    const unlock = (e) => {
      if (!bgmWantOn) return;
      if (e.target?.closest?.("#bgm-toggle")) return;
      const audio = bgmEl();
      if (audio && !audio.paused) {
        app.removeEventListener("pointerdown", unlock);
        return;
      }
      playBgm().then((ok) => {
        if (ok) app.removeEventListener("pointerdown", unlock);
      });
    };
    app.addEventListener("pointerdown", unlock, { passive: true });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) return;
      if (bgmWantOn && bgmEl()?.paused) playBgm();
    });
  }

  function initBgm() {
    // 进入小程序默认开启（清掉历史误关记录）
    bgmWantOn = true;
    writeBgmMuted(false);
    const audio = bgmEl();
    if (audio) {
      audio.loop = true;
      audio.setAttribute("playsinline", "");
      audio.setAttribute("webkit-playsinline", "");
      audio.addEventListener("play", syncBgmButton);
      audio.addEventListener("pause", () => {
        syncBgmButton();
      });
    }
    syncBgmButton();
    bindBgmUnlockOnce();
    playBgm();
    setTimeout(() => {
      if (bgmWantOn && bgmEl()?.paused) playBgm();
    }, 400);
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

  let pendingTodoTip = null;

  function toast(msg, ms = 1700) {
    toastEl.hidden = false;
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.classList.remove("show");
      setTimeout(() => (toastEl.hidden = true), 220);
    }, ms);
  }

  function flushPendingTodoTip() {
    if (!pendingTodoTip) return;
    const sample =
      pendingTodoTip.sample || "猫粮快吃完了，可能需要在最近一个月内补充";
    pendingTodoTip = null;
    toast(
      `已经为您摘录了一些您今日提到的注意事项（例如：${sample}）。具体的 To-do list 任务可以翻看手账本当中的「任务档案」。`,
      5600
    );
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
      /要买|记得|别忘|待办|提醒|补充|预约|该\S{0,6}了|快用完|只剩|快吃完|下周|本周内|一个月|需要买|猫砂|猫粮|驱虫|体检|注意事项/.test(
        t
      );
    if (!hit) return [];
    const parts = t
      .split(/[。！？\n]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((s) =>
        /要买|记得|别忘|待办|提醒|补充|预约|该|快用完|只剩|快吃完|猫砂|猫粮|驱虫|体检|需要|一个月|本周/.test(
          s
        )
      );
    const list = parts.length ? parts : [t];
    return list.map((s) => (s.length > 40 ? s.slice(0, 40) + "…" : s)).slice(0, 3);
  }

  function inferDueISO(text) {
    const now = new Date();
    const addDays = (n) => {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + n);
      return formatDateISO(d);
    };
    const t = String(text || "");
    if (/今天|今日|马上|立刻|赶紧/.test(t)) return addDays(0);
    if (/明天/.test(t)) return addDays(1);
    if (/本周|这周|周内/.test(t)) return addDays(7);
    if (/下周/.test(t)) return addDays(14);
    if (/最近一个月|一个月内|本月内|月内/.test(t)) return addDays(30);
    if (/快用完|只剩|快吃完/.test(t)) return addDays(14);
    return addDays(7);
  }

  function formatDueLabel(dueISO) {
    if (!dueISO) return "未设截止";
    const m = String(dueISO).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return dueISO;
    return `${m[2]}月${m[3]}日前`;
  }

  function sortedOpenTodos() {
    return state.todos
      .filter((t) => !t.done)
      .slice()
      .sort((a, b) => {
        const da = a.dueISO || "9999-12-31";
        const db = b.dueISO || "9999-12-31";
        if (da !== db) return da < db ? -1 : 1;
        return String(a.id).localeCompare(String(b.id));
      });
  }

  function ensureTodoDefaults() {
    let changed = false;
    (state.todos || []).forEach((t) => {
      if (!t.dueISO && !t.done) {
        t.dueISO = inferDueISO(t.text);
        changed = true;
      }
    });
    if (changed) saveState();
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
    const addedTodos = [];
    todos.forEach((line) => {
      const exists = state.todos.some((x) => !x.done && x.text === line);
      if (exists) return;
      const item = {
        id: "t-" + Date.now() + "-" + todoAdded,
        text: line,
        source: "来自今日日记",
        done: false,
        dueISO: inferDueISO(line),
      };
      state.todos.unshift(item);
      addedTodos.push(item);
      todoAdded += 1;
    });
    return { names, todoAdded, pets: createdPets, addedTodos };
  }

  function guessPet(text) {
    const extracted = extractPetNames(text);
    if (extracted.length) return extracted[0];
    const hit = state.pets.find((p) => text.includes(p.name));
    if (hit) return hit.name;
    return "";
  }

  const REL_GOOD_RE =
    /一起玩|一起晒|一起趴|一起睡|玩得很|玩得可|玩疯|追逐嬉戏|互相舔|依偎|依着|蹭来蹭去|好朋友|关系好|很亲|亲昵|黏在一起|陪着玩|打闹玩|互舔|一起趴窗边|抢着睡/;
  const REL_BAD_RE =
    /打架|打起来|互掐|掐架|吵架|拌嘴|抢地盘|抢食|讨厌|嫌弃|不理|不想理|躲着|追打|冷战|咬对方|互相咬|打对方|欺负|闹翻|关系差|关系不好/;

  function pairKey(a, b) {
    const x = normalizePetName(a);
    const y = normalizePetName(b);
    return x < y ? `${x}|${y}` : `${y}|${x}`;
  }

  function ensureRelation(a, b) {
    const ka = normalizePetName(a);
    const kb = normalizePetName(b);
    if (!ka || !kb || ka === kb) return null;
    if (!Array.isArray(state.relations)) state.relations = [];
    const key = pairKey(ka, kb);
    let rel = state.relations.find((r) => pairKey(r.a, r.b) === key);
    if (!rel) {
      const [x, y] = key.split("|");
      rel = { a: x, b: y, score: 0, good: 0, bad: 0, evidence: [] };
      state.relations.push(rel);
    }
    return rel;
  }

  /** 从一句日记里抽多宠互动信号 */
  function harvestRelationsFromText(text, { dateLabel = "" } = {}) {
    const names = extractPetNames(text);
    const set = new Set(names);
    if (set.size < 2) return [];
    const list = [...set];
    const hits = [];
    const sentences = String(text || "")
      .split(/[。！？；;\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
    const chunks = sentences.length ? sentences : [String(text || "")];

    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        let tone = 0;
        let snippet = "";
        for (const chunk of chunks) {
          if (!chunk.includes(a) || !chunk.includes(b)) continue;
          if (REL_BAD_RE.test(chunk)) {
            tone = -1;
            snippet = chunk.slice(0, 36);
            break;
          }
          if (REL_GOOD_RE.test(chunk)) {
            tone = 1;
            snippet = chunk.slice(0, 36);
            break;
          }
          if (!snippet) {
            tone = 0;
            snippet = chunk.slice(0, 36);
          }
        }
        if (!snippet) {
          const whole = String(text || "");
          if (REL_BAD_RE.test(whole)) tone = -1;
          else if (REL_GOOD_RE.test(whole)) tone = 1;
          snippet = whole.slice(0, 36);
        }
        const rel = ensureRelation(a, b);
        if (!rel) continue;
        if (tone > 0) {
          rel.good += 1;
          rel.score += 2;
        } else if (tone < 0) {
          rel.bad += 1;
          rel.score -= 2;
        } else {
          rel.score += 0.3;
        }
        const note = `${dateLabel ? dateLabel + " · " : ""}${snippet}${snippet.length >= 36 ? "…" : ""}`;
        if (note && !rel.evidence.includes(note)) {
          rel.evidence.unshift(note);
          rel.evidence = rel.evidence.slice(0, 6);
        }
        hits.push({ a, b, tone, rel });
      }
    }
    return hits;
  }

  function rebuildRelationsFromDiary() {
    state.relations = [];
    const sorted = [...state.entries].sort((a, b) => entryStamp(a) - entryStamp(b));
    sorted.forEach((e) => {
      const body = [e.caption, e.text].filter(Boolean).join("。");
      const withPet =
        e.pet && !String(body || "").includes(e.pet) ? `${e.pet}：${body}` : body;
      harvestRelationsFromText(withPet, {
        dateLabel: e.dateISO || e.date || "",
      });
    });
  }

  function relationsForPet(petName) {
    const n = normalizePetName(petName);
    if (!n || !Array.isArray(state.relations)) return [];
    return state.relations
      .filter((r) => r.a === n || r.b === n)
      .map((r) => ({
        ...r,
        other: r.a === n ? r.b : r.a,
        vibe:
          r.score <= -1.5 || r.bad > r.good
            ? "bad"
            : r.score >= 1.5 || r.good > r.bad
              ? "good"
              : "mixed",
      }))
      .sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
  }

  function summarizeRelationsForPet(petName) {
    const list = relationsForPet(petName);
    if (!list.length) return "";
    const goods = list.filter((r) => r.vibe === "good").map((r) => r.other);
    const bads = list.filter((r) => r.vibe === "bad").map((r) => r.other);
    const mixed = list.filter((r) => r.vibe === "mixed").map((r) => r.other);
    const lines = [];
    if (goods.length) lines.push(`处得不错：${goods.join("、")}`);
    if (bads.length) lines.push(`不太对付：${bads.join("、")}`);
    if (mixed.length) lines.push(`偶尔同框：${mixed.join("、")}`);
    return lines.join("\n");
  }

  function relationAwareReply(petName, userMsg) {
    const list = relationsForPet(petName);
    if (!list.length) return null;
    const goods = list.filter((r) => r.vibe === "good");
    const bads = list.filter((r) => r.vibe === "bad");
    const askHome =
      /在家|干什么|做什么|今天|最近|和谁|跟谁|玩|吵架|打架|关系|朋友|讨厌/.test(
        String(userMsg || "")
      );
    if (!askHome && Math.random() > 0.45) return null;

    const g = goods[0]?.other;
    const b = bads[0]?.other;
    if (g && b) {
      return `（${petName}）\n我跟${g}玩得挺好的，一起晒太阳、互相追着跑。\n可是${b}……我一直不太想理它，靠近就想躲开。`;
    }
    if (g) {
      return `（${petName}）\n在家的话，多半在跟${g}玩，或者挨着它趴一会儿。日记里我们也老一起出现。`;
    }
    if (b) {
      return `（${petName}）\n别提${b}。一见面就容易吵，我能躲多远躲多远。`;
    }
    const m = list[0]?.other;
    return m
      ? `（${petName}）\n家里还有${m}。我们偶尔同框，关系还说不清，你多记几篇就明白了。`
      : null;
  }

  function syncRelBox(petName) {
    const box = document.getElementById("rel-box");
    const text = document.getElementById("rel-text");
    if (!box || !text) return;
    const summary = summarizeRelationsForPet(petName);
    if (!summary) {
      box.hidden = true;
      text.textContent = "";
      return;
    }
    box.hidden = false;
    text.textContent = summary;
  }

  let shelfManaging = false;

  function buildShelf() {
    const shelf = document.getElementById("book-shelf");
    const empty = document.getElementById("shelf-empty");
    const manageBtn = document.getElementById("shelf-manage-btn");
    if (!shelf) return;

    const openTodos = sortedOpenTodos();
    const pets = state.pets;

    shelf.innerHTML = "";
    shelf.classList.toggle("is-managing", shelfManaging);
    if (manageBtn) {
      manageBtn.classList.toggle("is-on", shelfManaging);
      manageBtn.textContent = shelfManaging ? "完成管理" : "管理本子";
    }

    // 首次使用前就默认有「任务管理」本
    {
      const wrap = document.createElement("div");
      wrap.className = "mini-book-wrap";
      wrap.innerHTML = `
        <button type="button" class="mini-book is-todo" data-act="open-book" data-book="todo" aria-label="任务管理">
          <span class="mini-spine"></span>
          <span class="mini-face">
            <strong>任务管理</strong>
            <em>${openTodos.length ? openTodos.length + " 件待办" : "任务档案"}</em>
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

    const isEmpty = false;
    shelf.classList.toggle("is-empty", isEmpty);
    if (empty) empty.hidden = true;
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
    state.relations = (state.relations || []).filter((r) => r.a !== name && r.b !== name);
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

  function firstDiaryPhotoForPet(petName) {
    const n = normalizePetName(petName);
    if (!n) return "";
    const related = state.entries
      .filter((e) => {
        if (!e) return false;
        const hit =
          e.pet === n ||
          String(e.text || "").includes(n) ||
          String(e.caption || "").includes(n);
        if (!hit) return false;
        const img = String(e.image || "");
        if (!isUsableImage(img)) return false;
        // 排除占位图
        if (img.includes("eject-cat") || img.includes("ami-theater-select")) return false;
        return true;
      })
      .sort((a, b) => {
        const da = a.dateISO || "";
        const db = b.dateISO || "";
        if (da !== db) return da < db ? -1 : 1;
        return entryStamp(a) - entryStamp(b);
      });
    return related[0]?.image || "";
  }

  /** 自定义头像优先；否则用该角色日记里最早一张照片（智能取景缓存） */
  const avatarFocusCache = new Map();

  function resolvePetAvatarSrc(pet) {
    if (!pet) return "";
    if (pet.avatar && isUsableImage(pet.avatar)) return pet.avatar;
    const raw = firstDiaryPhotoForPet(pet.name);
    if (!raw) return "";
    return avatarFocusCache.get(raw) || raw;
  }

  /** 按主体（偏宠物脸）裁成正方形，避免只取画面正中 */
  function smartCropSquare(src, outSize = 320) {
    return new Promise((resolve) => {
      if (!src || avatarFocusCache.has(src)) {
        resolve(avatarFocusCache.get(src) || src);
        return;
      }
      const img = new Image();
      img.onload = () => {
        try {
          const iw = img.naturalWidth || img.width;
          const ih = img.naturalHeight || img.height;
          if (!iw || !ih) {
            resolve(src);
            return;
          }
          const probeW = 72;
          const probeH = Math.max(24, Math.round((probeW * ih) / iw));
          const probe = document.createElement("canvas");
          probe.width = probeW;
          probe.height = probeH;
          const pctx = probe.getContext("2d", { willReadFrequently: true });
          pctx.drawImage(img, 0, 0, probeW, probeH);
          const data = pctx.getImageData(0, 0, probeW, probeH).data;

          // 用边缘像素估背景色
          let br = 0,
            bg = 0,
            bb = 0,
            bn = 0;
          const edge = (x, y) => {
            const i = (y * probeW + x) * 4;
            br += data[i];
            bg += data[i + 1];
            bb += data[i + 2];
            bn += 1;
          };
          for (let x = 0; x < probeW; x++) {
            edge(x, 0);
            edge(x, probeH - 1);
          }
          for (let y = 1; y < probeH - 1; y++) {
            edge(0, y);
            edge(probeW - 1, y);
          }
          br /= bn;
          bg /= bn;
          bb /= bn;

          let sumW = 0,
            sumX = 0,
            sumY = 0;
          for (let y = 0; y < probeH; y++) {
            for (let x = 0; x < probeW; x++) {
              const i = (y * probeW + x) * 4;
              const r = data[i],
                g = data[i + 1],
                b = data[i + 2];
              const dr = r - br,
                dg = g - bg,
                db = b - bb;
              const dist = Math.sqrt(dr * dr + dg * dg + db * db);
              const lum = 0.299 * r + 0.587 * g + 0.114 * b;
              // 与背景差异大、且不要过曝地板；略偏上的位置加权（脸常在偏上）
              let score = Math.max(0, dist - 28);
              if (lum > 235) score *= 0.35;
              if (lum < 18) score *= 0.5;
              const yBias = 1.15 - (y / Math.max(1, probeH - 1)) * 0.35;
              score *= yBias;
              if (score < 8) continue;
              sumW += score;
              sumX += x * score;
              sumY += y * score;
            }
          }

          let cx = iw / 2;
          let cy = ih * 0.38;
          if (sumW > 0) {
            cx = (sumX / sumW) * (iw / probeW);
            cy = (sumY / sumW) * (ih / probeH);
          }

          // 正方形取景：略紧一点，更好露出脸
          const side = Math.min(iw, ih) * 0.92;
          let sx = cx - side / 2;
          let sy = cy - side / 2;
          sx = Math.max(0, Math.min(iw - side, sx));
          sy = Math.max(0, Math.min(ih - side, sy));

          const canvas = document.createElement("canvas");
          canvas.width = outSize;
          canvas.height = outSize;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, sx, sy, side, side, 0, 0, outSize, outSize);
          const out = canvas.toDataURL("image/jpeg", 0.86);
          avatarFocusCache.set(src, out);
          resolve(out);
        } catch {
          resolve(src);
        }
      };
      img.onerror = () => resolve(src);
      img.src = src;
    });
  }

  async function hydratePetAvatarDisplay(pet, imgEl) {
    if (!pet || !imgEl || pet.avatar) return;
    const raw = imgEl._avatarRaw || firstDiaryPhotoForPet(pet.name);
    if (!raw) return;
    const focused = await smartCropSquare(raw);
    if (imgEl._avatarRaw === raw || imgEl.getAttribute("src") === raw) {
      imgEl.src = focused;
    }
  }

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
      const rawDiary = !pet.avatar ? firstDiaryPhotoForPet(pet.name) : "";
      const avatarSrc = resolvePetAvatarSrc(pet);
      const avatarInner = avatarSrc
        ? `<img src="${avatarSrc}" alt="" />`
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
      const imgEl = wrap.querySelector(".theater-pet-avatar img");
      if (imgEl && rawDiary) {
        imgEl._avatarRaw = rawDiary;
        if (!avatarFocusCache.has(rawDiary)) hydratePetAvatarDisplay(pet, imgEl);
      }
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
      const dataUrl = await compressImage(file);
      pet.avatar = await smartCropSquare(dataUrl);
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
    const src = resolvePetAvatarSrc(pet);
    if (src) {
      const rawDiary = !pet?.avatar ? firstDiaryPhotoForPet(pet.name) : "";
      img.src = src;
      img.hidden = false;
      letter.hidden = true;
      if (rawDiary) {
        img._avatarRaw = rawDiary;
        if (!avatarFocusCache.has(rawDiary)) hydratePetAvatarDisplay(pet, img);
      } else {
        img._avatarRaw = "";
      }
    } else {
      img.removeAttribute("src");
      img.hidden = true;
      letter.hidden = false;
      letter.textContent = (pet?.name || "—").slice(0, 1);
      img._avatarRaw = "";
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

  /** 富士 Astia / 理光向：浓郁颗粒，不是 sepia 陈旧黄 */
  function applyFilmLook(ctx, width, height) {
    const id = ctx.getImageData(0, 0, width, height);
    const px = id.data;
    const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
    for (let i = 0; i < px.length; i += 4) {
      let r = px[i];
      let g = px[i + 1];
      let b = px[i + 2];

      // 略提对比（S 曲线感），保留中间调细节
      const c = 1.14;
      r = (r - 128) * c + 128;
      g = (g - 128) * c + 128;
      b = (b - 128) * c + 128;

      // 饱和：绿/蓝略推（Astia/Velvia 方向），肤色不过度发红发黄
      const avg = (r + g + b) / 3;
      r = avg + (r - avg) * 1.16;
      g = avg + (g - avg) * 1.22;
      b = avg + (b - avg) * 1.2;

      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (lum > 165) {
        // 高光微暖，不做 sepia 洗白
        r += 5;
        g += 2;
      } else if (lum < 70) {
        // 阴影略压深 + 一点点冷感
        r = r * 0.94 - 2;
        g = g * 0.96;
        b = b * 0.98 + 4;
      }

      // 细颗粒（胶片感），强度随亮度略变
      const grain = (Math.random() - 0.5) * (10 + (lum / 255) * 6);
      r += grain;
      g += grain * 0.92;
      b += grain * 0.88;

      px[i] = clamp(r);
      px[i + 1] = clamp(g);
      px[i + 2] = clamp(b);
    }
    ctx.putImageData(id, 0, 0);
  }

  function canvasToCover(canvas) {
    return canvas.toDataURL("image/jpeg", 0.86);
  }

  /** 拍立得相纸窗为正方形，取景/导出/展示统一 1:1 */
  const CROP_ASPECT = 1;
  const CROP_OUT_W = 960;

  function loadImageDataUrl(file, maxSide = 1600, withFilm = false) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        const scale = Math.min(1, maxSide / Math.max(width, height));
        width = Math.round(width * scale);
        height = Math.round(height * scale);
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        if (withFilm) applyFilmLook(ctx, width, height);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL("image/jpeg", withFilm ? 0.84 : 0.9));
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("image"));
      };
      img.src = url;
    });
  }

  function compressImage(file) {
    // 头像等：只压缩，不套胶片
    return loadImageDataUrl(file, 900, false);
  }

  function clampCrop() {
    if (!cropSession) return;
    const { nw, nh, scale } = cropSession;
    const vp = document.getElementById("crop-viewport");
    if (!vp) return;
    const W = vp.clientWidth;
    const H = vp.clientHeight;
    const sw = nw * scale;
    const sh = nh * scale;
    cropSession.tx = Math.min(0, Math.max(W - sw, cropSession.tx));
    cropSession.ty = Math.min(0, Math.max(H - sh, cropSession.ty));
  }

  function paintCrop() {
    if (!cropSession) return;
    const img = document.getElementById("crop-img");
    if (!img) return;
    clampCrop();
    img.style.width = `${cropSession.nw}px`;
    img.style.height = `${cropSession.nh}px`;
    img.style.transform = `translate(${cropSession.tx}px, ${cropSession.ty}px) scale(${cropSession.scale})`;
  }

  function resetCropFit() {
    if (!cropSession) return;
    const vp = document.getElementById("crop-viewport");
    if (!vp) return;
    const W = vp.clientWidth;
    const H = vp.clientHeight;
    const { nw, nh } = cropSession;
    cropSession.minScale = Math.max(W / nw, H / nh);
    cropSession.maxScale = cropSession.minScale * 4;
    cropSession.scale = cropSession.minScale;
    cropSession.tx = (W - nw * cropSession.scale) / 2;
    cropSession.ty = (H - nh * cropSession.scale) / 2;
    paintCrop();
  }

  function setCropZoom(factor, cx, cy) {
    if (!cropSession) return;
    const vp = document.getElementById("crop-viewport");
    if (!vp) return;
    const W = vp.clientWidth;
    const H = vp.clientHeight;
    const px = cx == null ? W / 2 : cx;
    const py = cy == null ? H / 2 : cy;
    const old = cropSession.scale;
    const next = Math.min(
      cropSession.maxScale,
      Math.max(cropSession.minScale, old * factor)
    );
    if (next === old) return;
    // 以视口点 (px,py) 为缩放中心
    const imgX = (px - cropSession.tx) / old;
    const imgY = (py - cropSession.ty) / old;
    cropSession.scale = next;
    cropSession.tx = px - imgX * next;
    cropSession.ty = py - imgY * next;
    paintCrop();
  }

  function openCropEditor(dataUrl, { mediaType = "image", videoUrl = "" } = {}) {
    const modal = document.getElementById("crop-modal");
    const img = document.getElementById("crop-img");
    if (!modal || !img) return;
    cropPendingMediaType = mediaType;
    cropPendingVideoUrl = videoUrl || "";
    if (cropSourceUrl && cropSourceUrl.startsWith("blob:")) {
      try {
        URL.revokeObjectURL(cropSourceUrl);
      } catch {
        /* ignore */
      }
    }
    cropSourceUrl = dataUrl;
    img.onload = () => {
      cropSession = {
        nw: img.naturalWidth,
        nh: img.naturalHeight,
        scale: 1,
        minScale: 1,
        maxScale: 4,
        tx: 0,
        ty: 0,
      };
      modal.hidden = false;
      requestAnimationFrame(() => resetCropFit());
      toast("拖动调整取景，＋/－缩放");
    };
    img.onerror = () => toast("图片打不开，换一张试试");
    img.src = dataUrl;
  }

  function closeCropEditor({ reopenPicker = false } = {}) {
    const modal = document.getElementById("crop-modal");
    if (modal) modal.hidden = true;
    cropSession = null;
    if (reopenPicker) {
      document.getElementById("p1-file")?.click();
    }
  }

  function exportCroppedPolaroid() {
    if (!cropSession) return null;
    const img = document.getElementById("crop-img");
    const vp = document.getElementById("crop-viewport");
    if (!img || !vp) return null;
    const W = vp.clientWidth;
    const H = vp.clientHeight;
    const outW = CROP_OUT_W;
    const outH = Math.round(outW / CROP_ASPECT);
    const canvas = document.createElement("canvas");
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext("2d");
    const sx = outW / W;
    const sy = outH / H;
    ctx.fillStyle = "#1a1a1a";
    ctx.fillRect(0, 0, outW, outH);
    ctx.drawImage(
      img,
      cropSession.tx * sx,
      cropSession.ty * sy,
      cropSession.nw * cropSession.scale * sx,
      cropSession.nh * cropSession.scale * sy
    );
    applyFilmLook(ctx, outW, outH);
    return canvas.toDataURL("image/jpeg", 0.78);
  }

  function confirmCrop() {
    const dataUrl = exportCroppedPolaroid();
    if (!dataUrl) {
      toast("取景失败，再试一次");
      return;
    }
    if (cropPendingMediaType === "video") {
      if (draftVideoUrl && draftVideoUrl !== cropPendingVideoUrl) {
        try {
          URL.revokeObjectURL(draftVideoUrl);
        } catch {
          /* ignore */
        }
      }
      draftVideoUrl = cropPendingVideoUrl;
      state.draft.mediaType = "video";
    } else {
      if (draftVideoUrl) {
        try {
          URL.revokeObjectURL(draftVideoUrl);
        } catch {
          /* ignore */
        }
        draftVideoUrl = "";
      }
      state.draft.mediaType = "image";
    }
    state.draft.image = dataUrl;
    saveState();
    syncDraftUI();
    closeCropEditor();
    toast(state.draft.mediaType === "video" ? "封面已取景 · 放入拍立得" : "已取景 · 放入拍立得");
  }

  function bindCropGestures() {
    const vp = document.getElementById("crop-viewport");
    if (!vp || vp.dataset.bound) return;
    vp.dataset.bound = "1";
    let mode = null; // pan | pinch
    let lastX = 0;
    let lastY = 0;
    let lastDist = 0;

    const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const mid = (a, b) => ({
      x: (a.clientX + b.clientX) / 2,
      y: (a.clientY + b.clientY) / 2,
    });

    vp.addEventListener(
      "pointerdown",
      (e) => {
        if (!cropSession) return;
        if (e.pointerType === "touch") return; // 触控交给 touch 手势
        vp.setPointerCapture(e.pointerId);
        mode = "pan";
        lastX = e.clientX;
        lastY = e.clientY;
        vp.classList.add("is-dragging");
      },
      { passive: true }
    );

    vp.addEventListener(
      "pointermove",
      (e) => {
        if (!cropSession || mode !== "pan" || e.pointerType === "touch") return;
        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;
        lastX = e.clientX;
        lastY = e.clientY;
        cropSession.tx += dx;
        cropSession.ty += dy;
        paintCrop();
      },
      { passive: true }
    );

    const endPan = (e) => {
      if (e && e.pointerType === "touch") return;
      mode = null;
      vp.classList.remove("is-dragging");
    };
    vp.addEventListener("pointerup", endPan);
    vp.addEventListener("pointercancel", endPan);

    vp.addEventListener(
      "touchstart",
      (e) => {
        if (!cropSession) return;
        if (e.touches.length === 2) {
          mode = "pinch";
          lastDist = dist(e.touches[0], e.touches[1]);
          return;
        }
        if (e.touches.length === 1) {
          mode = "pan";
          lastX = e.touches[0].clientX;
          lastY = e.touches[0].clientY;
          vp.classList.add("is-dragging");
        }
      },
      { passive: true }
    );
    vp.addEventListener(
      "touchmove",
      (e) => {
        if (!cropSession) return;
        if (e.touches.length === 2) {
          mode = "pinch";
          const d = dist(e.touches[0], e.touches[1]);
          if (!lastDist) {
            lastDist = d;
            return;
          }
          const rect = vp.getBoundingClientRect();
          const m = mid(e.touches[0], e.touches[1]);
          setCropZoom(d / lastDist, m.x - rect.left, m.y - rect.top);
          lastDist = d;
          return;
        }
        if (e.touches.length === 1 && mode === "pan") {
          const dx = e.touches[0].clientX - lastX;
          const dy = e.touches[0].clientY - lastY;
          lastX = e.touches[0].clientX;
          lastY = e.touches[0].clientY;
          cropSession.tx += dx;
          cropSession.ty += dy;
          paintCrop();
        }
      },
      { passive: true }
    );
    vp.addEventListener(
      "touchend",
      () => {
        mode = null;
        lastDist = 0;
        vp.classList.remove("is-dragging");
      },
      { passive: true }
    );

    vp.addEventListener(
      "wheel",
      (e) => {
        if (!cropSession) return;
        e.preventDefault();
        const rect = vp.getBoundingClientRect();
        setCropZoom(e.deltaY < 0 ? 1.08 : 1 / 1.08, e.clientX - rect.left, e.clientY - rect.top);
      },
      { passive: false }
    );
  }

  /** 从视频抽一帧（先不打胶片，留给取景导出） */
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
            const max = 1400;
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
            const cover = canvas.toDataURL("image/jpeg", 0.88);
            resolve({ cover, videoUrl: url });
          } catch {
            fail();
          }
        };
        video.addEventListener("seeked", onSeeked, { once: true });
        try {
          video.currentTime = t;
        } catch {
          setTimeout(onSeeked, 120);
        }
      };
      video.src = url;
      video.load();
    });
  }

  function syncDraftUI() {
    const preview = document.getElementById("p1-preview");
    const badge = document.getElementById("p1-media-badge");
    const text = document.getElementById("p1-text");
    const frame = document.getElementById("p1-frame");
    frame?.classList.toggle("has-draft", Boolean(state.draft.image));
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

  async function commitPendingEntry() {
    if (!pendingEntry) return;
    // 同日可多张：只追加，不再按 dateISO 覆盖旧片
    state.entries.unshift(pendingEntry);
    if (draftVideoUrl && pendingEntry.mediaType === "video") {
      sessionVideos.set(pendingEntry.id, draftVideoUrl);
    }
    draftVideoUrl = "";
    state.draft = { text: "", image: "", pet: pendingEntry.pet, mediaType: "image" };
    pendingEntry = null;
    rebuildRelationsFromDiary();
    await saveState();
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
            void commitPendingEntry().then(() => {
              if (cont) cont.hidden = false;
              // 照片显影完成后提示已摘录的待办
              setTimeout(() => flushPendingTodoTip(), 280);
            });
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
    if (id === "p3") {
      buildCalendar();
      // 若提前跳过吐片页，补一次待办摘录提示
      flushPendingTodoTip();
    }
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

  const DEEPSEEK_ENDPOINT = "https://api.deepseek.com/v1/chat/completions";
  const DEEPSEEK_MODEL = "deepseek-chat";

  function getLlmConfig() {
    try {
      const key = (localStorage.getItem("ami_llm_key") || window.AMI_LLM_KEY || "").trim();
      if (!key) return null;
      return {
        key,
        endpoint:
          localStorage.getItem("ami_llm_endpoint") ||
          window.AMI_LLM_ENDPOINT ||
          DEEPSEEK_ENDPOINT,
        model: localStorage.getItem("ami_llm_model") || window.AMI_LLM_MODEL || DEEPSEEK_MODEL,
        provider: "deepseek",
      };
    } catch {
      return null;
    }
  }

  function llmStatusLabel() {
    return getLlmConfig() ? "DeepSeek 已接入" : "未接大模型（用本地拟题）";
  }

  function setupDeepSeekKey() {
    const cur = localStorage.getItem("ami_llm_key") || "";
    const tip =
      "粘贴 DeepSeek API Key（以 sk- 开头）\n\n" +
      "获取：https://platform.deepseek.com/api_keys\n" +
      "留空并确定 = 清除 Key，改回本地拟题\n\n" +
      "说明：浏览器直连可能受跨域限制；失败时会自动用本地规则兜底。";
    const next = window.prompt(tip, cur);
    if (next == null) return;
    const key = String(next).trim();
    if (!key) {
      localStorage.removeItem("ami_llm_key");
      toast("已关闭大模型 · 改用本地拟题");
      return;
    }
    localStorage.setItem("ami_llm_key", key);
    localStorage.setItem("ami_llm_endpoint", DEEPSEEK_ENDPOINT);
    localStorage.setItem("ami_llm_model", DEEPSEEK_MODEL);
    toast("DeepSeek 已保存 · 吐片时会优先用它拟标题");
  }

  async function llmTitleFromStory(text, pet) {
    const cfg = getLlmConfig();
    if (!cfg) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
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
      if (!res.ok) {
        console.warn("[ami-llm] title http", res.status);
        return null;
      }
      const data = await res.json();
      const out = data?.choices?.[0]?.message?.content || "";
      return clampTitle(out.split("\n")[0], 10) || null;
    } catch (err) {
      console.warn("[ami-llm] title fail", err);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function extractPolaroidTitle(text, pet) {
    const full = String(text || "").trim();
    if (!full) return pet ? `${pet}的今天` : "今天的阿咪";
    const fromLlm = await llmTitleFromStory(full, pet);
    if (fromLlm) {
      extractPolaroidTitle._usedLlm = true;
      return fromLlm;
    }
    extractPolaroidTitle._usedLlm = false;
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

    toast(text ? `正在拟短标题…（${llmStatusLabel()}）` : "准备吐片…");
    extractPolaroidTitle._usedLlm = false;
    const caption = text
      ? await extractPolaroidTitle(text, pet)
      : pet
        ? `${pet}的今天`
        : "今天的阿咪";

    const via = text && extractPolaroidTitle._usedLlm ? " · DeepSeek" : text ? " · 本地" : "";
    if (signals.todoAdded) {
      const sample =
        signals.addedTodos?.[0]?.text || "猫粮快吃完了，可能需要尽快补充";
      pendingTodoTip = {
        count: signals.todoAdded,
        sample,
      };
      toast(`短标题：${caption}${via}`);
    } else {
      pendingTodoTip = null;
      toast(`短标题：${caption}${via}`);
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
      toast(isVideo ? "正在抽取视频封面…" : "打开取景…");
      if (isVideo) {
        const { cover, videoUrl } = await extractVideoCover(file);
        openCropEditor(cover, { mediaType: "video", videoUrl });
      } else {
        const dataUrl = await loadImageDataUrl(file, 1600, false);
        openCropEditor(dataUrl, { mediaType: "image" });
      }
    } catch {
      toast(isVideo ? "视频读取失败，换一个试试" : "图片读取失败，换一张试试");
    }
  }

  function reopenCropOrPick() {
    if (cropSourceUrl) {
      openCropEditor(cropSourceUrl, {
        mediaType: state.draft.mediaType === "video" ? "video" : "image",
        videoUrl: draftVideoUrl || cropPendingVideoUrl,
      });
      return;
    }
    document.getElementById("p1-file")?.click();
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
    if (label) label.textContent = `${y}年${pad2(m + 1)}月`;

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
    const weekNames = ["日", "一", "二", "三", "四", "五", "六"];
    cells.forEach((d, idx) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cal-cell";
      if (!d) {
        btn.tabIndex = -1;
        btn.setAttribute("aria-hidden", "true");
        grid.appendChild(btn);
        return;
      }
      const w = weekNames[idx % 7];
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
            ? `${m + 1}月${d}日周${w} · ${hits.length}张`
            : `${m + 1}月${d}日周${w}打卡`
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
        btn.setAttribute("aria-label", `${m + 1}月${d}日周${w}`);
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
    toast(`${state.calYear}年${pad2(state.calMonth + 1)}月`);
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

  function clearMemoryPickCache() {
    try {
      localStorage.removeItem("ami_memory_pick_v1");
    } catch {
      /* ignore */
    }
  }

  function deleteCurrentDayEntry() {
    const e = dayHits[dayHitIndex];
    if (!e) return;
    const ok = window.confirm(
      "删除这张拍立得及其背后的故事？\n阅历缩略图、手账相关日记、放映室素材与精选回顾里对应内容也会去掉。"
    );
    if (!ok) return;

    const id = e.id;
    const petName = e.pet;
    const textLen = String(e.text || e.caption || "").length;

    state.entries = state.entries.filter((x) => x.id !== id);

    const pet = findPetByName(petName);
    if (pet) {
      pet.entryCount = Math.max(0, (pet.entryCount || 1) - 1);
      pet.chars = Math.max(0, (pet.chars || 0) - textLen);
    }

    if (sessionVideos.has(id)) {
      const url = sessionVideos.get(id);
      sessionVideos.delete(id);
      if (url && String(url).startsWith("blob:")) {
        try {
          URL.revokeObjectURL(url);
        } catch {
          /* ignore */
        }
      }
    }

    clearMemoryPickCache();
    rebuildRelationsFromDiary();
    saveState();
    buildCalendar();
    buildShelf();
    buildTheater();
    if (pageId === "m1") buildMemories(true);
    if (pageId === "j2") renderJournal();

    dayHits = dayHits.filter((x) => x.id !== id);
    if (!dayHits.length) {
      closeDayModal();
      toast("已删除这张拍立得");
      return;
    }
    if (dayHitIndex >= dayHits.length) dayHitIndex = dayHits.length - 1;
    renderDayEntry();
    toast("已删除这张拍立得");
  }

  function toggleDayFlip(e) {
    if (dayDidSwipe) {
      dayDidSwipe = false;
      return;
    }
    // 背面滚动文字时不触发翻面
    if (e.target.closest(".day-story")) return;
    if (e.target.closest("video, .flip-close, .day-nav, .day-delete")) return;
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
        if (e.target.closest("video, .day-story, .flip-close, .day-nav, .day-delete")) return;
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
    ensureTodoDefaults();
    list.innerHTML = "";
    const open = sortedOpenTodos();
    if (!open.length) {
      const empty = document.createElement("li");
      empty.className = "todo-item";
      empty.style.border = "0";
      empty.innerHTML = `<div class="todo-body"><p style="color:#9aa094;font-size:1rem">暂无待办。日记里提到买猫粮、预约体检等，拍完照片后会自动摘录到这里。</p></div>`;
      list.appendChild(empty);
      return;
    }
    open.forEach((t) => {
      const li = document.createElement("li");
      li.className = "todo-item";
      li.dataset.id = t.id;
      li.innerHTML = `
        <button type="button" class="todo-check" aria-label="完成"></button>
        <div class="todo-body">
          <p>${escapeHtml(t.text)}</p>
          <small>${escapeHtml(t.source || "手动添加")}</small>
        </div>
        <button type="button" class="todo-due" data-act="edit-todo-due" data-id="${t.id}" aria-label="修改截止日期">${formatDueLabel(t.dueISO)}</button>`;
      li.querySelector(".todo-check").addEventListener("click", () => completeTodo(li, t.id));
      list.appendChild(li);
    });
  }

  function editTodoDue(id) {
    const item = state.todos.find((t) => t.id === id);
    if (!item || item.done) return;
    const cur = item.dueISO || formatDateISO(new Date());
    const next = window.prompt("设定完成截止日期（格式：年-月-日，如 2026-09-20）", cur);
    if (next == null) return;
    const v = String(next).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      toast("请按 2026-09-20 这种格式填写");
      return;
    }
    const parts = v.split("-").map(Number);
    const dt = new Date(parts[0], parts[1] - 1, parts[2]);
    if (
      dt.getFullYear() !== parts[0] ||
      dt.getMonth() !== parts[1] - 1 ||
      dt.getDate() !== parts[2]
    ) {
      toast("日期无效，请再检查一下");
      return;
    }
    item.dueISO = v;
    saveState();
    buildTodos();
    buildShelf();
    toast(`已改为 ${formatDueLabel(v)}，列表已重排`);
  }

  function completeTodo(li, id) {
    if (li.classList.contains("is-checked")) return;
    li.querySelector(".todo-check")?.classList.add("is-on");
    li.classList.add("is-checked");
    // 变灰划线 → 向下移出并消失
    setTimeout(() => {
      li.classList.add("is-done");
      setTimeout(() => {
        const item = state.todos.find((t) => t.id === id);
        if (item) item.done = true;
        saveState();
        li.remove();
        buildShelf();
        if (!sortedOpenTodos().length) buildTodos();
      }, 520);
    }, 380);
  }

  function addTodo(text) {
    const t = text.trim();
    if (!t) return;
    state.todos.unshift({
      id: "t-" + Date.now(),
      text: t,
      source: "手动添加",
      done: false,
      dueISO: inferDueISO(t),
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

  function diaryTextsForPet(petName) {
    const n = normalizePetName(petName);
    return state.entries
      .filter((e) => e.pet === n || String(e.text || "").includes(n))
      .sort((a, b) => entryStamp(b) - entryStamp(a))
      .map((e) => {
        const cap = (e.caption || "").trim();
        const body = (e.text || "").trim();
        if (cap && body && cap !== body) return `${cap}：${body}`;
        return body || cap;
      })
      .filter(Boolean)
      .slice(0, 12);
  }

  function localTraitsFromDiary(petName, snippets) {
    const joined = snippets.join("\n");
    const bits = [];
    const push = (s) => {
      if (s && !bits.includes(s) && bits.length < 3) bits.push(s);
    };
    if (/晒太阳|阳光|窗边|午后/.test(joined)) push("偏爱安静光亮处");
    if (/纸箱|纸盒|钻/.test(joined)) push("好奇、爱钻小空间");
    if (/零食|罐头|猫粮|饿|要吃/.test(joined)) push("对吃的很上心");
    if (/玩|玩具|逗猫|扑/.test(joined)) push("玩心重、易被逗起");
    if (/睡|趴|打盹|懒/.test(joined)) push("节奏偏慢、爱趴着");
    if (/怕|吓|躲|吸尘器|雷/.test(joined)) push("遇惊吓会退缩");
    if (/踩|键盘|书桌|腿|黏/.test(joined)) push("黏人、爱凑热闹");
    if (/夜|夜里|黑/.test(joined)) push("夜里更有精神");
    if (!bits.length) {
      return `${petName}还在慢慢成形：日记里有日常，但性格轮廓还不清晰。可再记几篇，或先手写一两句。`;
    }
    return `${petName}给人的感觉偏「${bits.join("、")}」。以上是从近期日记里抽出的简短判断，可随时改。`;
  }

  async function llmTraitsFromDiary(petName, snippets) {
    const cfg = getLlmConfig();
    if (!cfg || !snippets.length) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
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
          max_tokens: 140,
          messages: [
            {
              role: "system",
              content:
                "你是宠物日记分析助手。根据日记写出该宠物的「性格描述」，中文。" +
                "要求：2～3 句即可；先给简短、抽象的性格判断（如黏人、谨慎、爱玩），再最多带 1～2 个很小的日记细节作点缀；细节尽量少。" +
                "只依据给定日记，不要编造未出现的事实。不要标题，不要列表符号，直接输出正文。",
            },
            {
              role: "user",
              content: `宠物名：${petName}\n日记摘录：\n- ${snippets.join("\n- ")}\n\n请输出性格描述：`,
            },
          ],
        }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const out = String(data?.choices?.[0]?.message?.content || "").trim();
      return out ? out.replace(/^["「]|["」]$/g, "").slice(0, 220) : null;
    } catch (err) {
      console.warn("[ami-llm] traits fail", err);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  function syncTraitMeta(pet, source) {
    const meta = document.getElementById("trait-meta");
    if (!meta) return;
    const n = diaryTextsForPet(pet?.name).length;
    if (source === "llm") meta.textContent = `已用 DeepSeek · 依据 ${n} 条日记`;
    else if (source === "local") meta.textContent = `本地生成 · 依据 ${n} 条日记`;
    else if (pet?.traits) meta.textContent = n ? `可改 · 现有 ${n} 条相关日记` : "可手改";
    else meta.textContent = n ? `有 ${n} 条日记可生成` : "暂无相关日记";
  }

  async function generateTraitsForCurrentPet() {
    const pet = findPetByName(currentPetId);
    if (!pet) {
      toast("还没有角色");
      return;
    }
    const snippets = diaryTextsForPet(pet.name);
    const btn = document.getElementById("gen-traits-btn");
    const box = document.getElementById("trait-text");
    if (!snippets.length) {
      toast("还没有关于它的日记，先去记几篇再生成");
      return;
    }
    if (btn) btn.disabled = true;
    toast(getLlmConfig() ? "DeepSeek 正在写性格…" : "正在根据日记整理性格…");
    try {
      let text = await llmTraitsFromDiary(pet.name, snippets);
      let source = "llm";
      if (!text) {
        text = localTraitsFromDiary(pet.name, snippets);
        source = "local";
      }
      pet.traits = text;
      if (box) box.value = text;
      saveState();
      syncTraitMeta(pet, source);
      toast(source === "llm" ? "性格已生成（DeepSeek）" : "性格已生成（本地）");
    } finally {
      if (btn) btn.disabled = false;
    }
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
    const help = document.getElementById("trait-help");
    const diaryN = diaryTextsForPet(currentPetId).length;
    if (help) {
      help.textContent = pet.traits
        ? "下面是这只宠物的性格描述（角色卡）。可直接改字，改完点输入框外会自动保存；也会影响放映室怎么回你。"
        : "「它的性格」= 角色卡正文。现在还是空的：可手写，或点「用日记生成」让 AI/本地规则根据日记填写。";
    }
    if (traitBox) {
      traitBox.value = pet.traits || "";
      traitBox.placeholder = diaryN
        ? "还没有性格描述。点「用日记生成」，或自己写：爱晒太阳、黏人、怕吸尘器…"
        : "还没有性格描述。先记几篇带它名字的日记，再回来生成。";
    }
    syncTraitMeta(pet, pet.traits ? "saved" : "");
    syncRelBox(currentPetId);
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
    const relLine = summarizeRelationsForPet(currentPetId);
    if (relLine) {
      setTimeout(() => {
        addPetBubble(
          `（${currentPetId}想了想家里那些事）\n${relLine.replace(/\n/g, "；")}`
        );
      }, 700);
    }
  }

  function addPetBubble(text) {
    const wrap = document.createElement("div");
    wrap.className = "bubble pet";
    wrap.dataset.pet = currentPetId;
    wrap.innerHTML = `<div>${text.replace(/\n/g, "<br>")}</div>
      <div class="bubble-actions">
        <button type="button" data-fb="like" aria-label="点赞" title="喜欢">👍</button>
        <button type="button" data-fb="dislike" aria-label="点踩" title="不喜欢">👎</button>
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
    const relReply = relationAwareReply(currentPetId, text);
    if (relReply) {
      setTimeout(() => addPetBubble(relReply), 420);
      return;
    }
    const replyFn = pack.replies[Math.floor(Math.random() * pack.replies.length)];
    setTimeout(() => addPetBubble(replyFn(traits, text, currentPetId)), 420);
  }

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function hashSeed(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function seededShuffle(arr, seed) {
    const a = [...arr];
    let s = seed >>> 0;
    for (let i = a.length - 1; i > 0; i--) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      const j = s % (i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  const MEMORY_THEMES = [
    {
      id: "eat",
      title: "干饭时刻",
      hint: "跟吃有关的那些瞬间",
      keywords: /吃|饭|粮|罐头|零食|觅食|小鱼干|饿|碗/,
    },
    {
      id: "sun",
      title: "追光的日子",
      hint: "窗边、光斑与午后",
      keywords: /晒|太阳|阳光|窗边|午后|光斑|暖/,
    },
    {
      id: "play",
      title: "玩耍时光",
      hint: "闹腾与好奇",
      keywords: /玩|玩具|逗|扑|纸箱|跑|跳|抓/,
    },
    {
      id: "sleep",
      title: "小憩合集",
      hint: "软成一滩的瞬间",
      keywords: /睡|趴|盹|懒|窝|打呼|眯/,
    },
    {
      id: "night",
      title: "夜里的它",
      hint: "夜晚与安静",
      keywords: /夜|夜里|晚|月光|黑/,
    },
    { id: "onthisday", title: "那年今日", hint: "往年今天留下的照片", type: "onthisday" },
    { id: "recent", title: "最近的温柔", hint: "近两周里挑出来的", type: "recent" },
    { id: "pet", title: "只关于它", hint: "某一只的专场回顾", type: "pet" },
  ];

  function entryBlob(e) {
    return `${e.caption || ""} ${e.text || ""} ${e.pet || ""}`;
  }

  function filterEntriesByTheme(entries, theme, seed) {
    const today = new Date();
    const md = `${pad2(today.getMonth() + 1)}-${pad2(today.getDate())}`;
    if (theme.type === "onthisday") {
      return entries.filter((e) => String(e.dateISO || "").slice(5) === md);
    }
    if (theme.type === "recent") {
      const cut = Date.now() - 14 * 24 * 3600 * 1000;
      return entries.filter((e) => {
        const t = Date.parse(e.dateISO || "");
        return Number.isFinite(t) ? t >= cut : true;
      });
    }
    if (theme.type === "pet") {
      const pets = [...new Set(entries.map((e) => e.pet).filter(Boolean))];
      if (!pets.length) return [];
      const name = pets[seed % pets.length];
      theme.title = `${name}专场`;
      theme.hint = `只看「${name}」的精选`;
      return entries.filter((e) => e.pet === name);
    }
    if (theme.keywords) {
      return entries.filter((e) => theme.keywords.test(entryBlob(e)));
    }
    return entries;
  }

  function pickMemoryCollection(forceRefresh = false) {
    const withPhoto = state.entries.filter((e) => e.image);
    const dayKey = formatDateISO(new Date());
    const storeKey = "ami_memory_pick_v1";
    if (!forceRefresh) {
      try {
        const cached = JSON.parse(localStorage.getItem(storeKey) || "null");
        if (cached?.day === dayKey && Array.isArray(cached.ids) && cached.ids.length) {
          const map = new Map(withPhoto.map((e) => [e.id, e]));
          const hits = cached.ids.map((id) => map.get(id)).filter(Boolean);
          if (hits.length) {
            return {
              theme: { id: cached.themeId, title: cached.title, hint: cached.hint },
              hits,
              fromCache: true,
            };
          }
        }
      } catch {
        /* ignore */
      }
    }

    const seedBase = hashSeed(dayKey + (forceRefresh ? String(Date.now()) : ""));
    const scored = MEMORY_THEMES.map((raw, i) => {
      const theme = { ...raw };
      const hits = filterEntriesByTheme(withPhoto, theme, seedBase + i);
      return { theme, hits };
    }).filter((c) => c.hits.length > 0);

    let chosen;
    if (!scored.length) {
      chosen = {
        theme: { id: "all", title: "精选回顾", hint: "还没有足够主题素材" },
        hits: withPhoto,
      };
    } else {
      chosen = scored[seedBase % scored.length];
    }

    const target = Math.min(15, Math.max(5, 5 + (seedBase % 11))); // 5–15
    const shuffled = seededShuffle(chosen.hits, seedBase);
    const hits = shuffled.slice(0, Math.min(target, shuffled.length));

    try {
      localStorage.setItem(
        storeKey,
        JSON.stringify({
          day: dayKey,
          themeId: chosen.theme.id,
          title: chosen.theme.title,
          hint: chosen.theme.hint,
          ids: hits.map((e) => e.id),
        })
      );
    } catch {
      /* ignore */
    }
    return { theme: chosen.theme, hits, fromCache: false };
  }

  async function polishMemoryTitle(theme, hits) {
    const cfg = getLlmConfig();
    if (!cfg || !hits.length) return null;
    const samples = hits
      .slice(0, 6)
      .map((e) => (e.caption || e.text || "").trim())
      .filter(Boolean)
      .slice(0, 5);
    if (!samples.length) return null;
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
          temperature: 0.6,
          max_tokens: 24,
          messages: [
            {
              role: "system",
              content:
                "你为宠物相册写「精选回顾」主题名。中文，不超过10个字，不要标点引号，只输出主题名。像诗意一点的相册标题。",
            },
            {
              role: "user",
              content: `底色主题：${theme.title}\n照片短句：${samples.join(" / ")}\n请输出主题名：`,
            },
          ],
        }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const out = String(data?.choices?.[0]?.message?.content || "")
        .trim()
        .split("\n")[0]
        .replace(/[「」"']/g, "");
      return out && out.length <= 12 ? out : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  let memSwipeGuard = false;

  function buildMemories(forceRefresh = false) {
    const rail = document.getElementById("mem-rail");
    const dots = document.getElementById("mem-dots");
    const titleEl = document.getElementById("mem-title");
    const subEl = document.getElementById("mem-sub");
    if (!rail || !dots) return;

    const withPhoto = state.entries.filter((e) => e.image);
    if (!withPhoto.length) {
      rail.innerHTML = `<article class="mem-slide"><div class="mem-polaroid"><p class="mem-cap" style="padding:40px 16px;text-align:center;color:#6b736c">还没有可回顾的照片<br/>去记一张吧</p></div></article>`;
      dots.innerHTML = "";
      if (titleEl) titleEl.textContent = "精选回顾";
      if (subEl) subEl.textContent = "有照片后，会按主题挑一小辑给你";
      return;
    }

    const pack = pickMemoryCollection(forceRefresh);
    const slides = pack.hits.map((e) => ({
      id: e.id,
      src: e.image,
      title: e.caption || formatJournalDate(e.dateISO),
      meta: `${e.pet || "日记"} · ${formatJournalDate(e.dateISO)}`,
      story: (e.text || "").trim() || e.caption || "这一天，被轻轻收进拍立得里。",
    }));

    if (titleEl) titleEl.textContent = pack.theme.title || "精选回顾";
    if (subEl) {
      subEl.textContent = `${pack.theme.hint || "主题精选"} · 共 ${slides.length} 张`;
    }

    rail.innerHTML = slides
      .map(
        (s) => `<article class="mem-slide">
          <div class="mem-flip" data-act="mem-flip" role="button" tabindex="0" aria-label="翻面看故事">
            <div class="mem-face mem-front">
              <div class="mem-polaroid">
                <img src="${escapeHtml(s.src)}" alt="" draggable="false" />
                <p class="mem-cap">${escapeHtml(s.title)}</p>
              </div>
            </div>
            <div class="mem-face mem-back">
              <div class="mem-polaroid mem-polaroid-back">
                <p class="mem-back-meta">${escapeHtml(s.meta)}</p>
                <div class="mem-story">${escapeHtml(s.story)}</div>
                <p class="mem-back-hint">轻触翻回正面</p>
              </div>
            </div>
          </div>
        </article>`
      )
      .join("");
    dots.innerHTML = slides.map((_, i) => `<span${i === 0 ? ' class="is-on"' : ""}></span>`).join("");

    let memIndex = 0;
    const sync = () => {
      const w = rail.clientWidth || 1;
      const idx = Math.round(rail.scrollLeft / w);
      memIndex = Math.max(0, Math.min(slides.length - 1, idx));
      [...dots.children].forEach((d, i) => d.classList.toggle("is-on", i === memIndex));
      // 滑走时收起翻面
      rail.querySelectorAll(".mem-flip.is-flipped").forEach((el, i) => {
        const slide = el.closest(".mem-slide");
        const si = [...rail.children].indexOf(slide);
        if (si !== memIndex) el.classList.remove("is-flipped");
      });
    };
    const goMem = (i) => {
      memIndex = Math.max(0, Math.min(slides.length - 1, i));
      rail.scrollTo({ left: memIndex * rail.clientWidth, behavior: "smooth" });
      sync();
    };
    rail.onscroll = () => {
      memSwipeGuard = true;
      sync();
      clearTimeout(rail._memScrollTimer);
      rail._memScrollTimer = setTimeout(() => {
        memSwipeGuard = false;
      }, 120);
    };
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
      if (e.target.closest(".mem-story")) return;
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

    // DeepSeek 润色主题名（有 Key 时）
    if (!pack.fromCache || forceRefresh) {
      polishMemoryTitle(pack.theme, pack.hits).then((nice) => {
        if (!nice || !titleEl) return;
        titleEl.textContent = nice;
        try {
          const raw = JSON.parse(localStorage.getItem("ami_memory_pick_v1") || "{}");
          raw.title = nice;
          localStorage.setItem("ami_memory_pick_v1", JSON.stringify(raw));
        } catch {
          /* ignore */
        }
      });
    }
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
      case "setup-llm":
        setupDeepSeekKey();
        break;
      case "export-backup":
        exportLocalBackup();
        break;
      case "import-backup":
        document.getElementById("backup-file")?.click();
        break;
      case "install-app":
        promptInstallApp();
        break;
      case "toggle-bgm":
        toggleBgm();
        break;
      case "mem-refresh":
        buildMemories(true);
        toast("已换一辑主题");
        break;
      case "mem-flip":
        if (memSwipeGuard) break;
        t.classList.toggle("is-flipped");
        break;
      case "pick-photo":
        if (state.draft.image) reopenCropOrPick();
        else document.getElementById("p1-file")?.click();
        break;
      case "crop-ok":
        confirmCrop();
        break;
      case "crop-cancel":
        closeCropEditor({ reopenPicker: true });
        break;
      case "crop-zoom-in":
        setCropZoom(1.12);
        break;
      case "crop-zoom-out":
        setCropZoom(1 / 1.12);
        break;
      case "crop-reset":
        resetCropFit();
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
      case "close-install":
        closeInstallGuide();
        break;
      case "delete-day-entry":
        deleteCurrentDayEntry();
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
      case "edit-todo-due":
        editTodoDue(t.dataset.id);
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
      case "gen-traits":
        generateTraitsForCurrentPet();
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
  bindCropGestures();

  document.getElementById("theater-avatar-file")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) await onTheaterAvatarFile(file);
  });

  document.getElementById("backup-file")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) await importLocalBackupFile(file);
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
  document.getElementById("install-modal")?.addEventListener("click", (e) => {
    if (e.target.id === "install-modal") closeInstallGuide();
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

  let deferredInstallPrompt = null;

  function isStandaloneApp() {
    return (
      window.matchMedia("(display-mode: standalone)").matches ||
      window.navigator.standalone === true ||
      document.referrer.includes("android-app://")
    );
  }

  function openInstallGuide() {
    const modal = document.getElementById("install-modal");
    if (modal) modal.hidden = false;
  }

  function closeInstallGuide() {
    const modal = document.getElementById("install-modal");
    if (modal) modal.hidden = true;
  }

  function promptInstallApp() {
    if (isStandaloneApp()) {
      toast("已经在主屏幕/应用里 · 日记存在本机");
      return;
    }
    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
      deferredInstallPrompt.userChoice.finally(() => {
        deferredInstallPrompt = null;
      });
      return;
    }
    openInstallGuide();
  }

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
  });

  // 月历默认对齐「今天」所在月
  {
    const now = new Date();
    if (state.calYear == null) state.calYear = now.getFullYear();
    if (state.calMonth == null) state.calMonth = now.getMonth();
  }

  async function bootLocalMemory() {
    ensureTodoDefaults();
    buildCalendar();
    syncDraftUI();
    buildShelf();
    buildTheater();
    rebuildRelationsFromDiary();
    const persisted = await requestPersistentStorage();
    const hydrated = await hydrateBlobs().catch(() => ({ missing: 0 }));
    // 把已有大图迁到 IDB，并改成引用式元数据（防止再撑爆）
    await saveState().catch(() => {});
    initBgm();
    go("p1");
    const n = state.entries.length;
    if (n > 0) {
      setTimeout(() => {
        toast(
          persisted
            ? `本机已记住 ${n} 条日记 · 可点左下「导出」备份`
            : `已加载 ${n} 条 · 建议点左下「导出」备份到电脑`,
          3200
        );
      }, 700);
    } else {
      setTimeout(() => {
        toast("数据默认存在本机浏览器，不花云费 · 重要回忆请「导出」", 3600);
      }, 800);
    }
    if (hydrated?.missing) {
      setTimeout(() => toast("有照片缺失，若有备份文件请点「导入」恢复", 4000), 4200);
    }
  }

  bootLocalMemory();
})();
