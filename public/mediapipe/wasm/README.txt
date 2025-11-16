将 MediaPipe Tasks Vision 的 WASM 运行时放到此目录，以启用本地加载（避免外网依赖）。

必须的文件（来自 @mediapipe/tasks-vision@latest/wasm）：
- vision_wasm_internal.js
- vision_wasm_internal.wasm
- vision_wasm_simd.wasm

下载示例（任选其一）：
1) 直接下载（无代理）
   curl -L -o public/mediapipe/wasm/vision_wasm_internal.js \
     "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm/vision_wasm_internal.js"
   curl -L -o public/mediapipe/wasm/vision_wasm_internal.wasm \
     "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm/vision_wasm_internal.wasm"
   curl -L -o public/mediapipe/wasm/vision_wasm_simd.wasm \
     "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm/vision_wasm_simd.wasm"

2) 使用代理（示例端口 7890）
   curl -x http://127.0.0.1:7890 -L -o public/mediapipe/wasm/vision_wasm_internal.js \
     "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm/vision_wasm_internal.js"
   curl -x http://127.0.0.1:7890 -L -o public/mediapipe/wasm/vision_wasm_internal.wasm \
     "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm/vision_wasm_internal.wasm"
   curl -x http://127.0.0.1:7890 -L -o public/mediapipe/wasm/vision_wasm_simd.wasm \
     "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm/vision_wasm_simd.wasm"

完成后，代码会优先从 /mediapipe/wasm 加载运行时；若缺失则自动回退到 CDN。