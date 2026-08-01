/* ============================================================
   EDIT ME — everything you'd want to customize lives here
   ============================================================ */
const CONFIG = {
  tutorName: "Zacarias La Leche",
  pricePerLesson: 50,
  originCode: "HOME",
  destinationCode: "DALLAS",   // shows on the boarding pass
  goalAmount: 2000,            // total travel fund goal, in dollars
  startingBalance: 150,        // balance before this demo session
  startingLessons: 3,          // lessons already "logged" before this demo
  captions: [
    "Hola, ¿cómo estás?",
    "This one's real time. Just for us.",
    "Ready for lesson number one?"
  ]
};
/* ============================================================ */

const screens = ["intro", "landing", "list", "call", "fund",
                 "vtlobby", "vtcreate", "vtjoin", "vtcall"];
function showScreen(name){
  screens.forEach(s => {
    document.getElementById("screen-" + s).classList.toggle("active", s === name);
  });
  window.scrollTo(0,0);
}

/* ---------- INTRO REEL ---------- */
(function initIntro(){
  const lines = document.querySelectorAll(".intro-line");
  const enterBtn = document.getElementById("btn-enter");
  let i = 0;
  function next(){
    if (i < lines.length){
      lines[i].classList.add("show");
      i++;
      setTimeout(next, 2200);
    } else {
      enterBtn.classList.add("show");
    }
  }
  setTimeout(next, 500);
  enterBtn.addEventListener("click", () => showScreen("landing"));
  document.getElementById("btn-skip").addEventListener("click", () => showScreen("landing"));
})();

/* ---------- LANDING -> LIST ---------- */
document.getElementById("btn-find-tutor").addEventListener("click", () => showScreen("list"));

/* ---------- LIST -> CALL ---------- */
document.getElementById("btn-book-trial").addEventListener("click", () => {
  showScreen("call");
  startCall();
});

/* decoy tutors just toast */
document.querySelectorAll(".tutor-card.decoy").forEach(card => {
  card.addEventListener("click", () => {
    const toast = document.getElementById("toast");
    toast.textContent = card.getAttribute("data-toast");
    toast.classList.add("show");
    setTimeout(() => toast.classList.remove("show"), 2200);
  });
});

/* ---------- CALL SCREEN ---------- */
let callInterval = null;
let callSeconds = 0;
function startCall(){
  callSeconds = 0;
  document.getElementById("call-timer").textContent = "00:00";
  clearInterval(callInterval);
  callInterval = setInterval(() => {
    callSeconds++;
    const m = String(Math.floor(callSeconds/60)).padStart(2,"0");
    const s = String(callSeconds%60).padStart(2,"0");
    document.getElementById("call-timer").textContent = m + ":" + s;
  }, 1000);

  const captionsEl = document.getElementById("captions");
  captionsEl.innerHTML = "";
  CONFIG.captions.forEach((text, idx) => {
    setTimeout(() => {
      const bubble = document.createElement("div");
      bubble.className = "caption-bubble";
      bubble.textContent = text;
      captionsEl.appendChild(bubble);
    }, 1400 * (idx + 1));
  });
}

document.getElementById("btn-end-call").addEventListener("click", () => {
  clearInterval(callInterval);
  logLesson();
  showScreen("fund");
  renderFund(true);
});

/* ---------- TRAVEL FUND ---------- */
function getFundState(){
  const raw = localStorage.getItem("lengua_fund");
  if (raw){
    try { return JSON.parse(raw); } catch(e){}
  }
  return { balance: CONFIG.startingBalance, lessons: CONFIG.startingLessons };
}
function setFundState(state){
  localStorage.setItem("lengua_fund", JSON.stringify(state));
}
function logLesson(){
  const state = getFundState();
  state.balance += CONFIG.pricePerLesson;
  state.lessons += 1;
  setFundState(state);
}
function renderFund(animate){
  const state = getFundState();
  document.getElementById("fund-origin").textContent = CONFIG.originCode;
  document.getElementById("fund-destination").textContent = CONFIG.destinationCode;
  document.getElementById("fund-goal").textContent = "$" + CONFIG.goalAmount.toLocaleString();
  document.getElementById("fund-lessons").textContent = state.lessons;

  const pct = Math.min(100, Math.round((state.balance / CONFIG.goalAmount) * 100));
  const amountEl = document.getElementById("fund-amount");
  const fillEl = document.getElementById("fund-fill");
  const planeEl = document.getElementById("fund-plane");

  if (animate){
    const start = Math.max(0, state.balance - CONFIG.pricePerLesson);
    let current = start;
    amountEl.textContent = "$" + current;
    fillEl.style.width = "0%";
    planeEl.style.left = "0%";
    setTimeout(() => {
      fillEl.style.width = pct + "%";
      planeEl.style.left = pct + "%";
      const steps = 20;
      const inc = (state.balance - start) / steps;
      let n = 0;
      const timer = setInterval(() => {
        n++;
        current += inc;
        amountEl.textContent = "$" + Math.round(current);
        if (n >= steps){
          clearInterval(timer);
          amountEl.textContent = "$" + state.balance;
        }
      }, 40);
    }, 100);
  } else {
    amountEl.textContent = "$" + state.balance;
    fillEl.style.width = pct + "%";
    planeEl.style.left = pct + "%";
  }
}

document.getElementById("btn-again").addEventListener("click", () => showScreen("list"));

renderFund(false);
