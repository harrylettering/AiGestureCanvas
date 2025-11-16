import { HandLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";

const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const video = document.getElementById("video");

const cameraToggle = document.getElementById("cameraToggle");
const clearBtn = document.getElementById("clearBtn");
const saveBtn = document.getElementById("saveBtn");
const undoBtn = document.getElementById("undoBtn");
const drawStatus = document.getElementById("drawStatus");
const colorButtons = Array.from(document.querySelectorAll(".color"));
const sizeButtons = Array.from(document.querySelectorAll(".size"));
const sensitivityInput = document.getElementById("sensitivity");
const sensitivityValue = document.getElementById("sensitivityValue");
const mirrorToggle = document.getElementById("mirrorToggle");
const currentColorSwatch = document.getElementById("currentColorSwatch");
const currentSizeText = document.getElementById("currentSizeText");
const customColorInput = document.getElementById("customColor");

let stream = null;
let handLandmarker = null;
let running = false; // video loop
let drawEnabled = false; // drawing state toggled by pinch
let brushColor = "#ffffff";
let brushSize = 8;
let lastPoint = null; // for smoothing
// 水平镜像开关：前置摄像头常需镜像以符合直觉
let MIRROR_X = true;

// 撤销支持：记录已完成的笔画
const strokes = [];
let currentStroke = null;
let prevDrawEnabled = false;

// Pinch detection
let isPinching = false;
let pinchStartTime = 0;
// 使用迟滞阈值提高稳定性：进入捏合更严格，退出捏合更宽松
const PINCH_ON = 0.08;  // 进入捏合阈值（归一化距离）
const PINCH_OFF = 0.12; // 退出捏合阈值（归一化距离）
const LONG_PINCH_MS = 800; // 长捏合时间阈值（毫秒）
// 动态阈值与平滑/稳定参数
let ON_COEF = 0.4;   // 进入捏合阈值系数（相对于掌宽）
let OFF_COEF = 0.6;  // 退出捏合阈值系数（相对于掌宽）
let PINCH_EMA_ALPHA = 0.5; // 捏合距离指数平滑系数
let ENTER_FRAMES = 3; // 连续满足进入条件的帧数
let EXIT_FRAMES = 3;  // 连续满足退出条件的帧数
let pinchDistEMA = null;
let pinchFramesBelow = 0;
let pinchFramesAbove = 0;

// 撤销（中指捏合）检测状态
let isUndoPinching = false;
let undoPinchStartTime = 0;
let undoPinchDistEMA = null;
let undoFramesBelow = 0;
let undoFramesAbove = 0;

// 模型路径（本地优先，失败回退到远程 latest）
const LOCAL_MODEL_PATH = "/models/hand_landmarker.task";
const REMOTE_MODEL_PATH =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float32/latest/hand_landmarker.task";

function fitCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.floor(rect.width * dpr);
  canvas.height = Math.floor(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // 尺寸变化后，如存在已记录笔画则重绘
  redrawAll();
}

window.addEventListener("resize", fitCanvas);
fitCanvas();

// 灵敏度调节：1(低)~5(高)
function applySensitivity(level) {
  const labels = { 1: "低", 2: "较低", 3: "中", 4: "较高", 5: "高" };
  if (sensitivityValue) sensitivityValue.textContent = labels[level] || String(level);

  // 根据灵敏度映射参数：更高灵敏度 => 更低进入阈值/更少稳定帧/更强跟随
  switch (level) {
    case 1:
      ON_COEF = 0.45; OFF_COEF = 0.7; PINCH_EMA_ALPHA = 0.4; ENTER_FRAMES = 4; EXIT_FRAMES = 4; break;
    case 2:
      ON_COEF = 0.42; OFF_COEF = 0.65; PINCH_EMA_ALPHA = 0.45; ENTER_FRAMES = 3; EXIT_FRAMES = 3; break;
    case 3:
      ON_COEF = 0.40; OFF_COEF = 0.60; PINCH_EMA_ALPHA = 0.5; ENTER_FRAMES = 3; EXIT_FRAMES = 3; break;
    case 4:
      ON_COEF = 0.35; OFF_COEF = 0.55; PINCH_EMA_ALPHA = 0.55; ENTER_FRAMES = 2; EXIT_FRAMES = 2; break;
    case 5:
      ON_COEF = 0.30; OFF_COEF = 0.50; PINCH_EMA_ALPHA = 0.6; ENTER_FRAMES = 2; EXIT_FRAMES = 2; break;
    default:
      ON_COEF = 0.40; OFF_COEF = 0.60; PINCH_EMA_ALPHA = 0.5; ENTER_FRAMES = 3; EXIT_FRAMES = 3; break;
  }
  // 重置平滑与稳定计数，避免旧状态影响
  pinchDistEMA = null;
  pinchFramesBelow = 0;
  pinchFramesAbove = 0;
}

if (sensitivityInput) {
  sensitivityInput.addEventListener("input", () => {
    const lvl = parseInt(sensitivityInput.value, 10);
    applySensitivity(isNaN(lvl) ? 3 : lvl);
  });
  // 初始化一次
  const initLvl = parseInt(sensitivityInput.value || "3", 10);
  applySensitivity(isNaN(initLvl) ? 3 : initLvl);
}

function setDrawStatus() {
  drawStatus.textContent = `绘制：${drawEnabled ? "开启" : "关闭"}${isPinching ? "（捏合中）" : ""}`;
}

function drawToCanvas(x, y) {
  ctx.strokeStyle = brushColor;
  ctx.lineWidth = brushSize;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // simple smoothing: draw from previous filtered point to new filtered point
  const alpha = 0.4;
  const newX = lastPoint ? lastPoint.x * (1 - alpha) + x * alpha : x;
  const newY = lastPoint ? lastPoint.y * (1 - alpha) + y * alpha : y;

  if (lastPoint) {
    ctx.beginPath();
    ctx.moveTo(lastPoint.x, lastPoint.y);
    ctx.lineTo(newX, newY);
    ctx.stroke();
  }
  // update lastPoint after drawing
  lastPoint = { x: newX, y: newY };
  // 记录当前笔画点位（使用平滑后的坐标）
  if (!currentStroke) {
    currentStroke = { color: brushColor, size: brushSize, points: [] };
  }
  currentStroke.points.push({ x: newX, y: newY });
}

function redrawAll() {
  if (!ctx || !canvas) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (const s of strokes) {
    if (!s.points || s.points.length < 2) continue;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.size;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (let i = 1; i < s.points.length; i++) {
      const p0 = s.points[i - 1];
      const p1 = s.points[i];
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
      ctx.stroke();
    }
  }
}

async function setupHandLandmarker() {
  // 选择 WASM 基路径：本地优先，失败回退到远程 CDN
  const LOCAL_WASM_BASE = "/mediapipe/wasm";
  const REMOTE_WASM_BASE = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm";
  let wasmBase = REMOTE_WASM_BASE;
  try {
    const resWasm = await fetch(`${LOCAL_WASM_BASE}/vision_wasm_internal.js`, { method: "GET", cache: "no-store" });
    if (resWasm.ok) {
      wasmBase = LOCAL_WASM_BASE;
    }
  } catch (_) {}

  const vision = await FilesetResolver.forVisionTasks(wasmBase);
  // 模型改为 Buffer 加载：优先本地，失败回退远程，避免内部 GET 被中止
  let modelBuffer = null;
  try {
    const resLocal = await fetch(LOCAL_MODEL_PATH, { cache: "no-store" });
    if (resLocal.ok) {
      modelBuffer = new Uint8Array(await resLocal.arrayBuffer());
    } else {
      throw new Error(`Local model not ok: ${resLocal.status}`);
    }
  } catch (_) {
    const resRemote = await fetch(REMOTE_MODEL_PATH, { cache: "no-store" });
    if (resRemote.ok) {
      modelBuffer = new Uint8Array(await resRemote.arrayBuffer());
    } else {
      throw new Error(`Remote model not ok: ${resRemote.status}`);
    }
  }

  handLandmarker = await HandLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetBuffer: modelBuffer },
    numHands: 1,
    runningMode: "VIDEO",
  });
}

async function diagnoseAssetStatus() {
  const status = { localModel: false, localWasm: false };
  try {
    const m = await fetch(LOCAL_MODEL_PATH, { method: "GET", cache: "no-store" });
    status.localModel = m.ok;
  } catch (_) {}
  try {
    const w = await fetch(`/mediapipe/wasm/vision_wasm_internal.js`, { method: "GET", cache: "no-store" });
    status.localWasm = w.ok;
  } catch (_) {}
  return status;
}

async function startCamera() {
  if (stream) return;
  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "user" },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
  video.style.display = "block"; // 显示右下角预览
  running = true;
  lastPoint = null;
  requestAnimationFrame(processFrame);
}

function stopCamera() {
  running = false;
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  video.pause();
  video.srcObject = null;
  video.style.display = "none";
}

function normToCanvas(nx, ny) {
  // landmarks are [0,1] with origin top-left
  const rect = canvas.getBoundingClientRect();
  const xNorm = MIRROR_X ? (1 - nx) : nx;
  return { x: xNorm * rect.width, y: ny * rect.height };
}

function updatePinch(landmarks) {
  const now = performance.now();
  const thumb = landmarks[4];
  const index = landmarks[8];
  if (!thumb || !index) return;

  // 当前捏合距离（归一化坐标系）
  const dx = thumb.x - index.x;
  const dy = thumb.y - index.y;
  const dist = Math.hypot(dx, dy);

  // 以掌宽作为尺度：用食指掌指关节(5)到小指掌指关节(17)的距离
  const mcpIndex = landmarks[5];
  const mcpPinky = landmarks[17];
  let palmWidth = 0.1; // 兜底默认值，避免为0
  if (mcpIndex && mcpPinky) {
    const pwx = mcpIndex.x - mcpPinky.x;
    const pwy = mcpIndex.y - mcpPinky.y;
    palmWidth = Math.max(0.0001, Math.hypot(pwx, pwy));
  }

  // 动态阈值（相对于掌宽）
  const dynPinchOn = ON_COEF * palmWidth;
  const dynPinchOff = OFF_COEF * palmWidth;

  // 指数平滑捏合距离，降低抖动
  if (pinchDistEMA == null) {
    pinchDistEMA = dist;
  } else {
    pinchDistEMA = PINCH_EMA_ALPHA * dist + (1 - PINCH_EMA_ALPHA) * pinchDistEMA;
  }

  // 帧稳定：进入/退出条件需要连续满足若干帧
  if (pinchDistEMA < dynPinchOn) {
    pinchFramesBelow++;
    pinchFramesAbove = 0;
  } else if (pinchDistEMA > dynPinchOff) {
    pinchFramesAbove++;
    pinchFramesBelow = 0;
  }

  if (!isPinching) {
    if (pinchFramesBelow >= ENTER_FRAMES) {
      isPinching = true;
      pinchStartTime = now;
      pinchFramesBelow = 0; // 重置计数
    }
  } else {
    if (pinchFramesAbove >= EXIT_FRAMES) {
      const heldMs = now - pinchStartTime;
      isPinching = false;
      pinchFramesAbove = 0;
      if (heldMs >= LONG_PINCH_MS) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        lastPoint = null;
        strokes.length = 0;
        currentStroke = null;
      } else {
        drawEnabled = !drawEnabled;
      }
    }
  }
}

// 中指捏合撤销：与绘制的食指捏合分离，避免冲突
function updateUndoPinch(landmarks) {
  const now = performance.now();
  const thumb = landmarks[4];
  const middle = landmarks[12];
  if (!thumb || !middle) return;

  const dx = thumb.x - middle.x;
  const dy = thumb.y - middle.y;
  const dist = Math.hypot(dx, dy);

  const mcpIndex = landmarks[5];
  const mcpPinky = landmarks[17];
  let palmWidth = 0.1;
  if (mcpIndex && mcpPinky) {
    const pwx = mcpIndex.x - mcpPinky.x;
    const pwy = mcpIndex.y - mcpPinky.y;
    palmWidth = Math.max(0.0001, Math.hypot(pwx, pwy));
  }

  const dynPinchOn = ON_COEF * palmWidth;
  const dynPinchOff = OFF_COEF * palmWidth;

  if (undoPinchDistEMA == null) {
    undoPinchDistEMA = dist;
  } else {
    undoPinchDistEMA = PINCH_EMA_ALPHA * dist + (1 - PINCH_EMA_ALPHA) * undoPinchDistEMA;
  }

  if (undoPinchDistEMA < dynPinchOn) {
    undoFramesBelow++;
    undoFramesAbove = 0;
  } else if (undoPinchDistEMA > dynPinchOff) {
    undoFramesAbove++;
    undoFramesBelow = 0;
  }

  if (!isUndoPinching) {
    if (undoFramesBelow >= ENTER_FRAMES) {
      isUndoPinching = true;
      undoPinchStartTime = now;
      undoFramesBelow = 0;
    }
  } else {
    if (undoFramesAbove >= EXIT_FRAMES) {
      const heldMs = now - undoPinchStartTime;
      isUndoPinching = false;
      undoFramesAbove = 0;
      // 短捏合触发撤销；避免与长捏合清空冲突；绘制中不撤销
      if (heldMs < LONG_PINCH_MS && !drawEnabled) {
        undoLastStroke();
      }
    }
  }
}

async function processFrame() {
  if (!running || !handLandmarker) return;
  const ts = performance.now();
  const result = handLandmarker.detectForVideo(video, ts);
  if (result && result.landmarks && result.landmarks.length > 0) {
    const lm = result.landmarks[0];
    updatePinch(lm);
    updateUndoPinch(lm);
    setDrawStatus();
    // 检测绘制开关变化：开始或结束一段笔画
    if (drawEnabled && !prevDrawEnabled) {
      currentStroke = { color: brushColor, size: brushSize, points: [] };
    } else if (!drawEnabled && prevDrawEnabled) {
      if (currentStroke && currentStroke.points && currentStroke.points.length > 1) {
        strokes.push(currentStroke);
      }
      currentStroke = null;
    }
    prevDrawEnabled = drawEnabled;
    if (drawEnabled) {
      const tip = lm[8]; // index fingertip
      const { x, y } = normToCanvas(tip.x, tip.y);
      drawToCanvas(x, y);
    } else {
      lastPoint = null;
    }
  }
  requestAnimationFrame(processFrame);
}

cameraToggle.addEventListener("click", async () => {
  if (!handLandmarker) {
    cameraToggle.disabled = true;
    cameraToggle.textContent = "加载模型中...";
    try {
      await setupHandLandmarker();
    } catch (e) {
      console.error(e);
      cameraToggle.disabled = false;
      cameraToggle.textContent = "开启摄像头";
      diagnoseAssetStatus().then((s) => {
        if (!s.localModel) {
          drawStatus.textContent = "模型缺失：将 hand_landmarker.task 放到 public/models/";
        } else if (!s.localWasm) {
          drawStatus.textContent = "WASM 缺失：将 vision_wasm_* 放到 public/mediapipe/wasm/";
        } else {
          drawStatus.textContent = "网络受限：请启用代理或确保可访问 CDN";
        }
      });
      return;
    }
    cameraToggle.disabled = false;
    cameraToggle.textContent = stream ? "关闭摄像头" : "开启摄像头";
  }
  if (stream) {
    stopCamera();
    cameraToggle.textContent = "开启摄像头";
  } else {
    await startCamera();
    cameraToggle.textContent = "关闭摄像头";
  }
});

clearBtn.addEventListener("click", () => {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  lastPoint = null;
  strokes.length = 0;
  currentStroke = null;
});

saveBtn.addEventListener("click", () => {
  const url = canvas.toDataURL("image/png");
  const a = document.createElement("a");
  a.href = url;
  a.download = `gesture-canvas-${Date.now()}.png`;
  a.click();
});

// 撤销最后一个完成的笔画
undoBtn.addEventListener("click", () => {
  undoLastStroke();
});

function undoLastStroke() {
  if (strokes.length > 0) {
    strokes.pop();
    redrawAll();
    lastPoint = null;
  }
}

colorButtons.forEach((btn) =>
  btn.addEventListener("click", () => {
    brushColor = btn.dataset.color;
    // 更新当前颜色显示与按钮选中态
    if (currentColorSwatch) currentColorSwatch.style.background = brushColor;
    colorButtons.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    // 同步自定义选择器的值
    if (customColorInput) customColorInput.value = brushColor;
  })
);

sizeButtons.forEach((btn) =>
  btn.addEventListener("click", () => {
    brushSize = parseInt(btn.dataset.size, 10);
    // 更新当前粗细显示与按钮选中态
    if (currentSizeText) currentSizeText.textContent = `${brushSize}px`;
    sizeButtons.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
  })
);

setDrawStatus();

// 初始化当前颜色/粗细状态显示与选中态
if (currentColorSwatch) currentColorSwatch.style.background = brushColor;
if (currentSizeText) currentSizeText.textContent = `${brushSize}px`;
const initColorBtn = colorButtons.find((b) => b.dataset.color === brushColor);
if (initColorBtn) initColorBtn.classList.add("active");
const initSizeBtn = sizeButtons.find((b) => parseInt(b.dataset.size, 10) === brushSize);
if (initSizeBtn) initSizeBtn.classList.add("active");

// 绑定自定义颜色选择器
if (customColorInput) {
  customColorInput.addEventListener("input", () => {
    const val = customColorInput.value;
    if (val) {
      brushColor = val;
      if (currentColorSwatch) currentColorSwatch.style.background = brushColor;
      // 取消预设按钮选中态
      colorButtons.forEach((b) => b.classList.remove("active"));
    }
  });
}
// 镜像应用：同步画布映射与视频预览
function applyMirror(enabled) {
  MIRROR_X = !!enabled;
  if (video) {
    video.style.transform = MIRROR_X ? "scaleX(-1)" : "none";
    video.style.transformOrigin = "center";
  }
}

if (mirrorToggle) {
  applyMirror(mirrorToggle.checked);
  mirrorToggle.addEventListener("change", () => applyMirror(mirrorToggle.checked));
}