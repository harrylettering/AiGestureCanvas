将手部关键点模型文件放在本目录，以实现本地加载（离线/免外网）。

需要的文件：
- hand_landmarker.task

下载方式（任选其一）：
1) 直接下载（网络可访问 Google Storage 时）：
   curl -L \
     -o public/models/hand_landmarker.task \
     "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float32/latest/hand_landmarker.task"

2) 使用代理（如你有 http 代理在本机 127.0.0.1:7890）：
   curl -x http://127.0.0.1:7890 -L \
     -o public/models/hand_landmarker.task \
     "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float32/latest/hand_landmarker.task"

3) 手动拷贝：在其他能访问该链接的网络下载后，将文件拷贝到此目录并命名为 hand_landmarker.task。

前端代码会优先尝试从 /models/hand_landmarker.task 加载，若不存在则回退到远程 latest。