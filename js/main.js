import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getDatabase, ref, onValue, push, update } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { firebaseConfig } from "./firebase-config.js";

const $ = id => document.getElementById(id);
const state = { items: {}, rolls: {}, editingRoll: null };
let db = null, currentUser = null, toastTimer = null;

const configured = !!firebaseConfig &&
  firebaseConfig.apiKey && firebaseConfig.apiKey !== "PUT_YOUR_API_KEY_HERE" &&
  firebaseConfig.projectId && firebaseConfig.projectId !== "PUT_YOUR_PROJECT_ID_HERE" &&
  firebaseConfig.databaseURL && firebaseConfig.databaseURL.startsWith("https://");

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("show");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
}
function fmt(n) { return (Number(n) || 0).toLocaleString("en-US", { maximumFractionDigits: 2 }); }
function norm(v) { return String(v ?? "").trim().toLocaleLowerCase(); }
function values(obj) { return Object.entries(obj || {}).map(([id, v]) => ({ id, ...v })); }
function allRolls() {
  return values(state.rolls).sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
}
function itemName(id) {
  const item = state.items[id];
  return item ? `${item.code || "—"}${item.name ? " — " + item.name : ""}` : "كتالوج غير موجود";
}
function showPage(name) {
  document.querySelectorAll(".page").forEach(p => p.classList.toggle("active", p.id === `page-${name}`));
  document.querySelectorAll(".tab").forEach(b => b.classList.toggle("active", b.dataset.page === name));
}
function openDialog(id) {
  if (id === "rollDialog") populateItemSelect();
  if (id === "itemDialog") {
    $("itemForm").reset();
    $("rollRows").innerHTML = "";
    addRollRow();
  }
  $(id).showModal();
}
function closeDialogs() { document.querySelectorAll("dialog").forEach(d => d.close()); }
function populateItemSelect(selectedId = "") {
  const sel = $("rollItem");
  sel.innerHTML = "";
  values(state.items).sort((a, b) => String(a.code).localeCompare(String(b.code), "en")).forEach(item => {
    const opt = document.createElement("option");
    opt.value = item.id;
    opt.textContent = item.name ? `${item.code} — ${item.name}` : String(item.code);
    sel.appendChild(opt);
  });
  if (selectedId) sel.value = selectedId;
  if (!sel.options.length) toast("أضف كتالوجًا أولًا قبل إضافة لفة.");
}
function addRollRow() {
  const row = document.createElement("div");
  row.className = "roll-row";
  row.innerHTML = `
    <label>رقم اللون<input class="row-color" required maxlength="60" placeholder="مثال: 2"></label>
    <label>الطول بالمتر<input class="row-meters" required type="number" min="0.01" step="0.01" placeholder="60.3"></label>
    <button type="button" class="remove-row" aria-label="حذف هذه اللفة">حذف</button>`;
  row.querySelector(".remove-row").addEventListener("click", () => {
    if ($("rollRows").children.length > 1) row.remove();
    else toast("يجب أن تبقى خانة لفة واحدة على الأقل.");
  });
  $("rollRows").appendChild(row);
}
async function saveUpdates(updates) {
  if (!db || !currentUser) {
    toast("Firebase غير متصل. تحقق من الإعدادات والاتصال.");
    return false;
  }
  try {
    await update(ref(db, "inventory"), updates);
    return true;
  } catch (err) {
    console.error(err);
    toast("تعذر الحفظ. تحقق من اتصال الإنترنت وقواعد Firebase.");
    return false;
  }
}

document.querySelectorAll("[data-page]").forEach(button => button.addEventListener("click", () => showPage(button.dataset.page)));
document.querySelectorAll("[data-open]").forEach(button => button.addEventListener("click", () => openDialog(button.dataset.open)));
document.querySelectorAll("[data-close]").forEach(button => button.addEventListener("click", closeDialogs));
$("addRollRow").addEventListener("click", addRollRow);
$("itemSearch").addEventListener("input", renderItems);
$("rollSearch").addEventListener("input", renderRolls);
$("countSearch").addEventListener("input", renderCount);

$("itemForm").addEventListener("submit", async event => {
  event.preventDefault();
  const code = $("itemCode").value.trim();
  const name = $("itemName").value.trim();
  const notes = $("itemNotes").value.trim();
  const rows = [...$("rollRows").querySelectorAll(".roll-row")].map(row => ({
    color: row.querySelector(".row-color").value.trim(),
    meters: Number(row.querySelector(".row-meters").value)
  }));
  if (!code) return toast("أدخل رقم الكتالوج.");
  if (!rows.length || rows.some(r => !r.color || !(r.meters > 0))) return toast("أكمل رقم اللون والطول لكل لفة.");
  if (values(state.items).some(i => norm(i.code) === norm(code))) return toast("رقم الكتالوج موجود بالفعل. استخدمه من إضافة لفة واردة.");
  if (!db || !currentUser) return toast("اتصل بـ Firebase أولًا قبل الحفظ.");

  const itemId = push(ref(db, "inventory/items")).key;
  const now = Date.now();
  const updates = {};
  updates[`items/${itemId}`] = { code, name, notes, createdAt: now, createdBy: currentUser.uid };
  rows.forEach(row => {
    const rollId = push(ref(db, "inventory/rolls")).key;
    updates[`rolls/${rollId}`] = {
      itemId, code: row.color, meters: row.meters, actualMeters: null,
      counted: false, notes: "", createdAt: now, createdBy: currentUser.uid
    };
  });
  if (await saveUpdates(updates)) {
    event.target.reset();
    $("rollRows").innerHTML = "";
    closeDialogs();
    toast(`تم حفظ الكتالوج وإضافة ${rows.length} لفة.`);
  }
});

$("rollForm").addEventListener("submit", async event => {
  event.preventDefault();
  const itemId = $("rollItem").value;
  const color = $("rollCode").value.trim();
  const meters = Number($("rollMeters").value);
  const notes = $("rollNotes").value.trim();
  if (!itemId || !color || !(meters > 0)) return toast("أكمل رقم الكتالوج واللون والطول.");
  if (!db || !currentUser) return toast("اتصل بـ Firebase أولًا قبل الحفظ.");
  const rollId = push(ref(db, "inventory/rolls")).key;
  const roll = { itemId, code: color, meters, actualMeters: null, counted: false, notes, createdAt: Date.now(), createdBy: currentUser.uid };
  if (await saveUpdates({ [`rolls/${rollId}`]: roll })) {
    event.target.reset();
    closeDialogs();
    toast("تمت إضافة اللفة إلى الكتالوج.");
  }
});

$("countForm").addEventListener("submit", async event => {
  event.preventDefault();
  const roll = state.rolls[state.editingRoll];
  if (!roll) return toast("لم يتم تحديد اللفة.");
  const catalogEntered = $("countCatalog").value.trim();
  const colorEntered = $("countColor").value.trim();
  const actualMeters = Number($("actualMeters").value);
  const item = state.items[roll.itemId];
  const catalogMatches = item && norm(catalogEntered) === norm(item.code);
  const colorMatches = norm(colorEntered) === norm(roll.code);
  const metersMatch = Number.isFinite(actualMeters) && Math.abs(actualMeters - Number(roll.meters)) < 0.005;

  if (!catalogMatches || !colorMatches || !metersMatch) {
    const issues = [];
    if (!catalogMatches) issues.push("رقم الكتالوج");
    if (!colorMatches) issues.push("رقم اللون");
    if (!metersMatch) issues.push("الطول");
    toast(`لم تتم المطابقة: تحقق من ${issues.join(" و")}. لن تُعلَّم اللفة كمطابقة.`);
    return;
  }
  if (!db || !currentUser) return toast("Firebase غير متصل.");
  try {
    await update(ref(db, `inventory/rolls/${state.editingRoll}`), {
      actualMeters, counted: true, countedAt: Date.now(), countedBy: currentUser.uid,
      countNotes: $("countNotes").value.trim()
    });
    closeDialogs();
    toast("تم تأكيد المطابقة بنجاح.");
  } catch (err) {
    console.error(err);
    toast("تعذر حفظ المطابقة. تحقق من الاتصال.");
  }
});

function rollCard(roll, countMode = false) {
  const el = document.createElement("article");
  el.className = "roll-card";
  const main = document.createElement("div");
  main.className = "item-main";
  const title = document.createElement("strong");
  title.textContent = `كتالوج ${state.items[roll.itemId]?.code || "—"} · اللون ${roll.code || "—"}`;
  const p = document.createElement("p");
  p.textContent = `${fmt(roll.actualMeters ?? roll.meters)} متر${roll.counted ? " · مطابق" : " · بانتظار المطابقة"}`;
  main.append(title, p);
  const pill = document.createElement("span");
  pill.className = `pill ${roll.counted ? "done" : "pending"}`;
  pill.textContent = roll.counted ? "مطابقة" : "غير مطابق بعد";
  el.append(main, pill);
  const btn = document.createElement("button");
  btn.className = "small-btn";
  btn.textContent = countMode ? "مطابقة" : "عرض";
  btn.addEventListener("click", () => {
    if (!countMode) {
      toast(`الكتالوج ${state.items[roll.itemId]?.code || "—"} · اللون ${roll.code} · ${fmt(roll.meters)} متر`);
      return;
    }
    state.editingRoll = roll.id;
    $("countRollTitle").textContent = `المسجل: كتالوج ${state.items[roll.itemId]?.code || "—"} · اللون ${roll.code} · ${fmt(roll.meters)} متر`;
    $("countCatalog").value = state.items[roll.itemId]?.code || "";
    $("countColor").value = roll.code || "";
    $("actualMeters").value = roll.meters;
    $("countNotes").value = "";
    $("countDialog").showModal();
  });
  el.append(btn);
  
  const deleteBtn = document.createElement("button");
  deleteBtn.className = "small-btn";
  deleteBtn.textContent = "🗑️ حذف اللفة";

  deleteBtn.addEventListener("click", async () => {
    if (!confirm("هل أنت متأكد من حذف هذه اللفة؟")) {
      return;
    }

    const ok = await saveUpdates({
      [`rolls/${roll.id}`]: null
    });

    if (ok) {
      toast("تم حذف اللفة بنجاح");
    }
  });

  el.append(deleteBtn);

  return el;
}
function renderStats() {
  const rolls = allRolls();
  $("statRolls").textContent = fmt(rolls.length);
  $("statCounted").textContent = fmt(rolls.filter(r => r.counted).length);
  $("statMeters").textContent = fmt(rolls.reduce((sum, r) => sum + Number(r.meters || 0), 0));
  $("statItems").textContent = fmt(values(state.items).length);
}
function renderItems() {
  const q = norm($("itemSearch").value);
  const list = $("itemsList");
  list.innerHTML = "";
  const items = values(state.items).filter(i => norm(`${i.code} ${i.name || ""}`).includes(q))
    .sort((a, b) => String(a.code).localeCompare(String(b.code), "en"));
  if (!items.length) { list.className = "list empty"; list.textContent = "لا توجد كتالوجات مطابقة."; return; }
  list.className = "list";
  items.forEach(item => {
    const rolls = allRolls().filter(r => r.itemId === item.id);
    const card = document.createElement("article");
    card.className = "item-card";
    const main = document.createElement("div");
    main.className = "item-main";
    const title = document.createElement("strong");
    title.textContent = `كتالوج ${item.code}${item.name ? " — " + item.name : ""}`;
    const p = document.createElement("p");
    p.textContent = `${rolls.length} لفة · ${fmt(rolls.reduce((sum, r) => sum + Number(r.meters || 0), 0))} متر`;
    main.append(title, p);
    card.append(main);
    const btn = document.createElement("button");
    btn.className = "small-btn";
    btn.textContent = "إضافة لفة";
    btn.addEventListener("click", () => {
      populateItemSelect(item.id);
      $("rollCode").value = "";
      $("rollMeters").value = "";
      $("rollNotes").value = "";
      $("rollDialog").showModal();
    });
    card.append(btn);
    list.append(card);
  });
}
function renderRolls() {
  const q = norm($("rollSearch").value);
  const list = $("rollsList");
  list.innerHTML = "";
  const rolls = allRolls().filter(r => norm(`${r.code} ${state.items[r.itemId]?.code || ""} ${state.items[r.itemId]?.name || ""}`).includes(q));
  if (!rolls.length) { list.className = "list empty"; list.textContent = "لا توجد لفات مطابقة."; return; }
  list.className = "list";
  rolls.forEach(r => list.append(rollCard(r, false)));
}
function renderCount() {
  const q = norm($("countSearch").value);
  const list = $("countList");
  list.innerHTML = "";
  const rolls = allRolls().filter(r => !r.counted && norm(`${r.code} ${state.items[r.itemId]?.code || ""} ${state.items[r.itemId]?.name || ""}`).includes(q));
  if (!rolls.length) { list.className = "list empty"; list.textContent = "كل اللفات مطابقة، أو لم تتم إضافة لفات بعد."; return; }
  list.className = "list";
  rolls.forEach(r => list.append(rollCard(r, true)));
}
function renderReports() {
  const list = $("reportList");
  list.innerHTML = "";
  const items = values(state.items);
  if (!items.length) { list.className = "list empty"; list.textContent = "ستظهر التقارير بعد تسجيل الكتالوجات واللفات."; return; }
  list.className = "list";
  items.forEach(item => {
    const rolls = allRolls().filter(r => r.itemId === item.id);
    const meters = rolls.reduce((sum, r) => sum + Number(r.meters || 0), 0);
    const matched = rolls.filter(r => r.counted).length;
    const card = document.createElement("article");
    card.className = "item-card";
    const main = document.createElement("div");
    main.className = "item-main";
    const title = document.createElement("strong");
    title.textContent = `كتالوج ${item.code}${item.name ? " — " + item.name : ""}`;
    const p = document.createElement("p");
    p.textContent = `${rolls.length} لفة · ${fmt(meters)} متر · تمت مطابقة ${matched} من ${rolls.length}`;
    main.append(title, p);
    card.append(main);
    list.append(card);
  });
}
function renderRecent() {
  const list = $("recentRolls");
  list.innerHTML = "";
  const rolls = allRolls().slice(0, 5);
  if (!rolls.length) { list.className = "list empty"; list.textContent = "لا توجد لفات بعد. أضف كتالوجًا أو لفة للبدء."; return; }
  list.className = "list";
  rolls.forEach(r => list.append(rollCard(r, false)));
}
function render() { renderStats(); renderItems(); renderRolls(); renderCount(); renderReports(); renderRecent(); }

$("exportCsv").addEventListener("click", () => {
  const rows = [["رقم الكتالوج", "اسم القماش", "رقم اللون", "الطول بالمتر", "حالة المطابقة"],
    ...allRolls().map(r => [state.items[r.itemId]?.code || "", state.items[r.itemId]?.name || "", r.code || "", r.meters ?? "", r.counted ? "مطابق" : "غير مطابق بعد"])];
  const csv = "\uFEFF" + rows.map(row => row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
  const a = document.createElement("a");
  a.href = url; a.download = "جرد-ستائر-أركان-الطليعة.csv"; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

if (configured) {
  try {
    const app = initializeApp(firebaseConfig);
    db = getDatabase(app);
    const auth = getAuth(app);
    signInAnonymously(auth).catch(err => {
      console.error(err);
      $("connectionBadge").textContent = "تعذر تسجيل الدخول";
      $("connectionBadge").className = "badge muted";
      toast("فعّل تسجيل الدخول المجهول في Firebase Authentication.");
    });
    onAuthStateChanged(auth, user => {
      if (!user) return;
      currentUser = user;
      onValue(ref(db, "inventory"), snapshot => {
        const data = snapshot.val() || {};
        state.items = data.items || {};
        state.rolls = data.rolls || {};
        render();
        $("connectionBadge").textContent = "متصل ومتزامن";
        $("connectionBadge").className = "badge online";
      }, err => {
        console.error(err);
        $("connectionBadge").textContent = "خطأ في الاتصال";
        $("connectionBadge").className = "badge muted";
        toast("تعذر قراءة المخزون؛ تحقق من قواعد Realtime Database.");
      });
    });
  } catch (err) {
    console.error(err);
    $("connectionBadge").textContent = "راجع الإعدادات";
    toast("راجع ملف js/firebase-config.js.");
  }
} else {
  $("connectionBadge").textContent = "إعداد Firebase مطلوب";
  $("connectionBadge").className = "badge muted";
  render();
  toast("الواجهة جاهزة، لكن يلزم إعداد Firebase للحفظ المشترك.");
}
