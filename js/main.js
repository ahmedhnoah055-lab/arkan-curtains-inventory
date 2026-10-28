import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getDatabase, ref, onValue, push, update } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { firebaseConfig } from "./firebase-config.js";

const $ = id => document.getElementById(id);
const state = { items: {}, rolls: {} };
let db = null, currentUser = null, toastTimer = null;
const configured = !!firebaseConfig && firebaseConfig.apiKey &&
  firebaseConfig.apiKey !== "PUT_YOUR_API_KEY_HERE" && firebaseConfig.projectId &&
  firebaseConfig.projectId !== "PUT_YOUR_PROJECT_ID_HERE" &&
  firebaseConfig.databaseURL && firebaseConfig.databaseURL.startsWith("https://");

function toast(message) {
  const el = $("toast");
  if (!el) return;
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3800);
}
function fmt(n) { return (Number(n) || 0).toLocaleString("en-US", { maximumFractionDigits: 2 }); }
function norm(v) { return String(v ?? "").trim().toLocaleLowerCase(); }
function cleanColor(v) { return norm(v).replace(/\s+/g, ""); }
function values(obj) { return Object.entries(obj || {}).map(([id, v]) => ({ id, ...v })); }
function allRolls() { return values(state.rolls).sort((a,b) => Number(b.createdAt||0)-Number(a.createdAt||0)); }
function isShopRoll(r) { return r.location === "shop" || r.transferredToShop === true; }
function meters(r) { return Number(r.meters) || 0; }
function itemCode(r) { return r.catalogCode || state.items[r.itemId]?.code || "—"; }
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function showPage(name) {
  document.querySelectorAll(".page").forEach(p => p.classList.toggle("active", p.id === `page-${name}`));
  document.querySelectorAll(".tab").forEach(b => b.classList.toggle("active", b.dataset.page === name));
}
function closeDialogs() { document.querySelectorAll("dialog").forEach(d => d.close()); }
function openDialog(id) {
  if (id === "rollDialog") populateItemSelect();
  if (id === "itemDialog") { $("itemForm").reset(); $("rollRows").innerHTML = ""; addRollRow(); }
  if (id === "transferDialog") $("transferForm").reset();
  $(id).showModal();
}
function populateItemSelect(selectedId = "") {
  const sel = $("rollItem"); sel.innerHTML = "";
  values(state.items).sort((a,b) => String(a.code).localeCompare(String(b.code),"en")).forEach(item => {
    const o = document.createElement("option"); o.value = item.id;
    o.textContent = item.name ? `${item.code} — ${item.name}` : String(item.code);
    sel.appendChild(o);
  });
  if (selectedId) sel.value = selectedId;
  if (!sel.options.length) toast("أضف كتالوجًا أولًا قبل إضافة اللفات.");
}
function addRollRow() {
  const row = document.createElement("div"); row.className = "roll-row";
  row.innerHTML = `<label>رقم اللون<input class="row-color" required maxlength="60" placeholder="مثال: 2 أو 2#"></label>
  <label>أطوال هذا اللون بالمتر<textarea class="row-lengths" required rows="3" placeholder="60.3&#10;59&#10;68.5"></textarea></label>
  <button type="button" class="remove-row">حذف اللون</button>`;
  row.querySelector(".remove-row").addEventListener("click", () => {
    if ($("rollRows").children.length > 1) row.remove();
    else toast("يجب أن يبقى صف لون واحد على الأقل.");
  });
  $("rollRows").appendChild(row);
}
function parseLengths(s) {
  return String(s || "").split(/[\n,،;؛\t ]+/).map(x => x.trim()).filter(Boolean).map(Number);
}
async function saveUpdates(updates) {
  if (!db || !currentUser) { toast("Firebase غير متصل. تحقق من الإعدادات والاتصال."); return false; }
  try { await update(ref(db, "inventory"), updates); return true; }
  catch (e) { console.error(e); toast("تعذر الحفظ. تحقق من الإنترنت وقواعد Firebase."); return false; }
}
function newRoll(itemId, color, length, notes, now) {
  const item = state.items[itemId];
  return { itemId, catalogCode: String(item?.code || ""), color: String(color).trim(),
    code: String(color).trim(), meters: Number(length), actualMeters: null, counted: false,
    location: "warehouse", transferredToShop: false, notes: String(notes || "").trim(),
    createdAt: now, createdBy: currentUser.uid };
}
function appendNewRolls(updates, itemId, color, lengths, notes, now) {
  lengths.forEach(length => {
    const newRef = push(ref(db, "inventory/rolls"));
    updates[`rolls/${newRef.key}`] = newRoll(itemId, color, length, notes, now);
  });
}
function rollCard(r) {
  const shop = isShopRoll(r), el = document.createElement("article");
  el.className = "roll-card";
  const color = r.color ?? r.code ?? "—";
  el.innerHTML = `<div class="roll-card-main"><strong>كتالوج ${esc(itemCode(r))} · اللون ${esc(color)}</strong>
  <span>${fmt(meters(r))} متر</span><span class="pill ${shop ? "green" : ""}">${shop ? "في المحل" : "في المستودع"}</span>
  ${r.notes ? `<small>${esc(r.notes)}</small>` : ""}</div>
  <div class="roll-card-actions">${shop ? "" : '<button type="button" class="small-btn transfer-one">نقل للمحل</button>'}
  <button type="button" class="small-btn delete-one">🗑️ حذف اللفة</button></div>`;
  const transfer = el.querySelector(".transfer-one");
  if (transfer) transfer.addEventListener("click", async () => {
    if (!confirm(`نقل لفة كتالوج ${itemCode(r)}، اللون ${color}، بطول ${fmt(meters(r))} متر إلى المحل؟`)) return;
    const ok = await saveUpdates({
      [`rolls/${r.id}/location`]: "shop",
      [`rolls/${r.id}/transferredToShop`]: true,
      [`rolls/${r.id}/transferredAt`]: Date.now(),
      [`rolls/${r.id}/transferredBy`]: currentUser.uid
    });
    if (ok) toast("تم نقل اللفة إلى المحل.");
  });
  el.querySelector(".delete-one").addEventListener("click", async () => {
    if (!confirm(`هل أنت متأكد من حذف هذه اللفة ${shop ? "من المحل" : "من المستودع"} نهائيًا؟`)) return;
    if (await saveUpdates({ [`rolls/${r.id}`]: null })) toast("تم حذف اللفة وتحديث الإجماليات.");
  });
  return el;
}
function renderList(el, rolls, emptyText) {
  el.innerHTML = "";
  if (!rolls.length) { el.className = "list empty"; el.textContent = emptyText; return; }
  el.className = "list"; rolls.forEach(r => el.appendChild(rollCard(r)));
}
function renderStats() {
  const all = allRolls(), warehouse = all.filter(r => !isShopRoll(r)), shop = all.filter(isShopRoll);
  $("statRolls").textContent = fmt(warehouse.length);
  $("statCounted").textContent = fmt(shop.length);
  $("statMeters").textContent = fmt(warehouse.reduce((s,r)=>s+meters(r),0));
  $("statItems").textContent = fmt(values(state.items).length);
}
function renderItems() {
  const list = $("itemsList"), q = norm($("itemSearch").value);
  const items = values(state.items).filter(i => norm(`${i.code||""} ${i.name||""}`).includes(q))
    .sort((a,b)=>String(a.code).localeCompare(String(b.code),"en"));
  list.innerHTML = "";
  if (!items.length) { list.className = "list empty"; list.textContent = "لا توجد كتالوجات تطابق البحث."; return; }
  list.className = "list";
  items.forEach(item => {
    const rolls = allRolls().filter(r => r.itemId === item.id);
    const wh = rolls.filter(r=>!isShopRoll(r)), sh = rolls.filter(isShopRoll);
    const card = document.createElement("article"); card.className = "item-card";
    card.innerHTML = `<div><h3>${esc(item.code||"—")}${item.name ? " — "+esc(item.name) : ""}</h3>
    ${item.notes ? `<p>${esc(item.notes)}</p>` : ""}
    <p>المستودع: ${wh.length} لفة · ${fmt(wh.reduce((s,r)=>s+meters(r),0))} متر</p>
    <p>المحل: ${sh.length} لفة · ${fmt(sh.reduce((s,r)=>s+meters(r),0))} متر</p></div>
    <button type="button" class="small-btn add-to-item">＋ إضافة لفات</button>`;
    card.querySelector(".add-to-item").addEventListener("click",()=>{ openDialog("rollDialog"); populateItemSelect(item.id); });
    list.appendChild(card);
  });
}
function renderRolls() {
  const q = norm($("rollSearch").value);
  renderList($("rollsList"), allRolls().filter(r=>norm(`${itemCode(r)} ${r.color??r.code??""} ${r.meters}`).includes(q)), "لا توجد لفات تطابق البحث.");
}
function renderShop() {
  const q = norm($("countSearch").value);
  renderList($("countList"), allRolls().filter(isShopRoll).filter(r=>norm(`${itemCode(r)} ${r.color??r.code??""} ${r.meters}`).includes(q)), "لا توجد لفات منقولة إلى المحل.");
}
function renderReports() {
  const all = allRolls(), wh = all.filter(r=>!isShopRoll(r)), sh = all.filter(isShopRoll);
  const total = a=>a.reduce((s,r)=>s+meters(r),0);
  $("reportList").className = "list";
  $("reportList").innerHTML = `<article class="report-card"><strong>المستودع</strong><p>${wh.length} لفة · ${fmt(total(wh))} متر متبقٍ</p></article>
  <article class="report-card"><strong>المحل</strong><p>${sh.length} لفة · ${fmt(total(sh))} متر منقول</p></article>
  <article class="report-card"><strong>الإجمالي المسجل</strong><p>${all.length} لفة · ${fmt(total(all))} متر</p></article>
  <article class="report-card"><strong>عدد الكتالوجات</strong><p>${values(state.items).length}</p></article>`;
}
function render() {
  renderStats(); renderItems(); renderRolls(); renderShop(); renderReports();
  renderList($("recentRolls"), allRolls().slice(0,5), "لا توجد لفات بعد.");
}
document.addEventListener("click", e => {
  const p = e.target.closest("[data-page]"); if (p) showPage(p.dataset.page);
  const o = e.target.closest("[data-open]"); if (o) openDialog(o.dataset.open);
  if (e.target.closest("[data-close]")) closeDialogs();
});
$("addRollRow").addEventListener("click", addRollRow);
$("itemSearch").addEventListener("input", renderItems);
$("rollSearch").addEventListener("input", renderRolls);
$("countSearch").addEventListener("input", renderShop);

$("itemForm").addEventListener("submit", async e => {
  e.preventDefault();
  if (!db || !currentUser) return toast("انتظر حتى يتصل التطبيق بقاعدة البيانات.");
  const code = $("itemCode").value.trim(), name = $("itemName").value.trim(), notes = $("itemNotes").value.trim();
  if (!code) return toast("اكتب رقم الكتالوج.");
  if (values(state.items).some(i=>norm(i.code)===norm(code))) return toast("رقم الكتالوج موجود مسبقًا. أضف اللفات إليه من خيار إضافة لفات إلى المستودع.");
  const rows = [...document.querySelectorAll("#rollRows .roll-row")].map(row=>({
    color: row.querySelector(".row-color").value.trim(),
    lengths: parseLengths(row.querySelector(".row-lengths").value)
  }));
  if (!rows.length || rows.some(r=>!r.color || !r.lengths.length || r.lengths.some(n=>!Number.isFinite(n)||n<=0)))
    return toast("أدخل اللون وأطوالًا صحيحة أكبر من صفر لكل صف.");
  const itemRef = push(ref(db,"inventory/items")), itemId = itemRef.key, now = Date.now(), updates = {};
  updates[`items/${itemId}`] = {code,name,notes,createdAt:now,createdBy:currentUser.uid};
  // Make the new item available to the record builder before saving.
  state.items[itemId] = {code,name,notes};
  rows.forEach(r=>appendNewRolls(updates,itemId,r.color,r.lengths,"",now));
  delete state.items[itemId];
  if (await saveUpdates(updates)) { closeDialogs(); toast(`تم حفظ الكتالوج وإضافة ${rows.reduce((n,r)=>n+r.lengths.length,0)} لفة.`); }
});
$("rollForm").addEventListener("submit", async e => {
  e.preventDefault();
  if (!db || !currentUser) return toast("انتظر حتى يتصل التطبيق بقاعدة البيانات.");
  const itemId=$("rollItem").value, color=$("rollCode").value.trim(), lengths=parseLengths($("rollMeters").value), notes=$("rollNotes").value.trim();
  if (!itemId || !state.items[itemId]) return toast("اختر كتالوجًا صحيحًا.");
  if (!color || !lengths.length || lengths.some(n=>!Number.isFinite(n)||n<=0)) return toast("أدخل اللون وأطوالًا صحيحة أكبر من صفر.");
  const now=Date.now(), updates={}; appendNewRolls(updates,itemId,color,lengths,notes,now);
  if (await saveUpdates(updates)) { closeDialogs(); toast(`تمت إضافة ${lengths.length} لفة إلى المستودع.`); }
});
$("transferForm").addEventListener("submit", async e => {
  e.preventDefault();
  if (!db || !currentUser) return toast("انتظر حتى يتصل التطبيق بقاعدة البيانات.");
  const catalog=$("transferCatalog").value.trim(), color=$("transferColor").value.trim(), length=Number($("transferMeters").value);
  if (!catalog || !color || !Number.isFinite(length) || length<=0) return toast("تحقق من رقم الكتالوج واللون والطول.");
  const item=values(state.items).find(i=>norm(i.code)===norm(catalog));
  if (!item) return toast("لم نعثر على الكتالوج في المستودع. لم يتم نقل أي لفة.");
  const matches=allRolls().filter(r=>!isShopRoll(r) &&
    (r.itemId===item.id || norm(itemCode(r))===norm(catalog)) &&
    cleanColor(r.color??r.code??"")===cleanColor(color) && Math.abs(meters(r)-length)<0.0001)
    .sort((a,b)=>Number(a.createdAt||0)-Number(b.createdAt||0));
  if (!matches.length) return toast("لا توجد لفة متبقية تطابق الكتالوج واللون والطول تمامًا. لم يتغير المخزون.");
  const roll=matches[0], updates={
    [`rolls/${roll.id}/location`]:"shop",
    [`rolls/${roll.id}/transferredToShop`]:true,
    [`rolls/${roll.id}/transferredAt`]:Date.now(),
    [`rolls/${roll.id}/transferredBy`]:currentUser.uid
  };
  if (await saveUpdates(updates)) { closeDialogs(); toast(matches.length>1 ? "تم نقل لفة واحدة فقط من اللفات المتطابقة." : "تم نقل اللفة إلى المحل بنجاح."); }
});
$("exportCsv").addEventListener("click",()=>{
  const rows=[["الكتالوج","اسم القماش","اللون","الطول بالمتر","الموقع","ملاحظات"]];
  allRolls().forEach(r=>{ const i=state.items[r.itemId]||{}; rows.push([r.catalogCode||i.code||"",i.name||"",r.color??r.code??"",meters(r),isShopRoll(r)?"المحل":"المستودع",r.notes||""]); });
  const csv="\uFEFF"+rows.map(row=>row.map(v=>`"${String(v??"").replace(/"/g,'""')}"`).join(",")).join("\r\n");
  const url=URL.createObjectURL(new Blob([csv],{type:"text/csv;charset=utf-8;"})), a=document.createElement("a");
  a.href=url; a.download="جرد-ستائر-اركان-الطليعة.csv"; a.click(); URL.revokeObjectURL(url);
});
if (!configured) {
  $("connectionBadge").textContent="إعداد Firebase ناقص";
} else {
  try {
    const app=initializeApp(firebaseConfig); db=getDatabase(app); const auth=getAuth(app);
    signInAnonymously(auth).catch(err=>{console.error(err);$("connectionBadge").textContent="تعذر تسجيل الدخول";toast("تعذر تسجيل الدخول المجهول إلى Firebase.");});
    onAuthStateChanged(auth,user=>{
      currentUser=user; if(!user) return;
      onValue(ref(db,"inventory"),snap=>{
        const data=snap.val()||{}; state.items=data.items||{}; state.rolls=data.rolls||{};
        render(); $("connectionBadge").textContent="متصل ومتزامن"; $("connectionBadge").classList.remove("muted","error");
      },err=>{console.error(err);$("connectionBadge").textContent="خطأ في المزامنة";toast("تعذرت قراءة بيانات الجرد من Firebase.");});
    });
  } catch(err) { console.error(err); $("connectionBadge").textContent="تعذر الاتصال"; }
}
