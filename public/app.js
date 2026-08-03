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
                 "vtlobby", "vtcreate", "vtjoin", "vtcall", "beta"];
function showScreen(name){
  screens.forEach(s => {
    document.getElementById("screen-" + s).classList.toggle("active", s === name);
  });
  window.scrollTo(0,0);
  syncHash(name);
}

/* ---------- DEEP LINKS ----------
   The two live features are worth sending to someone directly, so each has a
   hash of its own. Two halves that have to agree: the address bar follows the
   screen, so whatever you are looking at is a link you can copy, and the screen
   follows the address bar, so a link someone pastes into a tab they already have
   open still goes somewhere. Without the second half a hash edit changes the URL
   and nothing else, since the browser doesn't reload for it. */
const SCREEN_HASH = { vtlobby: "#video", beta: "#tv" };
const HASH_SCREEN = { "#video": "vtlobby", "#tv": "beta" };

/* The screens inside a lesson keep the link you arrived on: a guest who came in
   through #join/123456 shouldn't have it rewritten under them, and the host has
   nothing shareable to offer beyond the lobby anyway. */
const HASH_KEEP = ["vtjoin", "vtcreate", "vtcall"];

function syncHash(name){
  if (HASH_KEEP.includes(name)) return;
  const want = SCREEN_HASH[name] || "";
  if ((location.hash || "") === want) return;   // nothing moved, nothing to record
  /* An entry, so the browser's back button walks back out of a deep-linked
     screen instead of leaving the site. pushState rather than assigning
     location.hash, which would re-enter the router through hashchange. */
  history.pushState(null, "", location.pathname + location.search + want);
}

function routeHash(){
  const hash = location.hash || "";
  const join = hash.match(/^#join\/(\d{6})$/);
  if (join){
    document.getElementById("vt-code-input").value = join[1];
    showScreen("vtjoin");
    return;
  }
  if (HASH_SCREEN[hash]) showScreen(HASH_SCREEN[hash]);
  // Backing out of a deep link lands on the landing page rather than replaying
  // the intro reel, which is a first-visit thing.
  else if (!hash) showScreen("landing");
}

window.addEventListener("hashchange", routeHash);

/* Deferred to DOMContentLoaded so the initial route runs after videotest.js and
   beta.js have wrapped showScreen — their wrappers release the camera and warm
   the TV audio, and a link straight into either screen has to get that too. It
   fires before images finish, so there is no flash of the intro screen. */
document.addEventListener("DOMContentLoaded", () => {
  if (location.hash) routeHash();
});

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
