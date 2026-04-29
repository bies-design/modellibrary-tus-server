// server.js
import path from 'path';
import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import { Server, EVENTS } from '@tus/server';
import { S3Store } from '@tus/s3-store';
import axios from 'axios';
import http from 'http';
import { Server as SocketServer } from 'socket.io';
import { QueueEvents, Queue } from 'bullmq'; 
import IORedis from 'ioredis';
import {nanoid} from 'nanoid';
import { PrismaClient } from './prisma/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { CopyObjectCommand, S3Client } from '@aws-sdk/client-s3';

// 目前tus上task對照表 提供哪一個task屬於哪user的對照功能
// 💡 修改：改為儲存物件，包含 userId 與加入時間，以便定期清理
const activeTasksMap = new Map<string, { userId: string, timestamp: number }>();

// --- 定義定時清理機制 (解決問題 4) ---
// 每 30 分鐘檢查一次，移除超過 2 小時的任務對照，防止記憶體洩漏
setInterval(() => {
    const now = Date.now();
    const TWO_HOURS = 2 * 60 * 60 * 1000;
    let count = 0;
    activeTasksMap.forEach((value, key) => {
        if (now - value.timestamp > TWO_HOURS) {
            activeTasksMap.delete(key);
            count++;
        }
    });
    if (count > 0) console.log(`🧹 [Cleanup] 已移除 ${count} 個過期任務對照`);
}, 30 * 60 * 1000);

const result = dotenv.config({ path: path.resolve(process.cwd(), '.env') });  // 用 process.cwd() 代替 __dirname
if (result.error){
    console.warn("Warning: [!] 沒有實體 .env 檔案，將嘗試從環境變數讀取。");
}
else{
    console.log("DEBUG: Tus-Server working type =", process.env.BRANCH); // 👈 檢查這行有沒有印出東西
}

// import { int } from 'zod';
// 初始化prisma
const adapter = new PrismaPg({connectionString:process.env.POSTGRESDB_URI});
const prisma = new PrismaClient({adapter});


const app = express();
// 建立 HTTP Server (為了綁定 WebSocket)
const server = http.createServer(app);

// 設定 Exporess CORS (關鍵！否則前端會被擋)
// 這裡我們允許來自 localhost:3000 的請求
const corsOptions = {
    origin: '*', 
    methods: ['GET', 'POST', 'PATCH', 'HEAD', 'OPTIONS', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Location', 'Tus-Resumable', 'Upload-Length', 'Upload-Metadata', 'Upload-Offset', 'Upload-Protocol', 'X-HTTP-Method-Override', 'Authorization'],
    exposedHeaders: ['Tus-Resumable', 'Upload-Length', 'Upload-Metadata', 'Upload-Offset', 'Upload-Protocol', 'Location', 'Upload-Expires'],
};

app.use(cors(corsOptions));

// 讓 Express 支援 JSON 解析 (為了接收 Worker 的通知)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- API Key 驗證 Middleware ---
const authMiddleware = (req: any, res: any, next: any) => {
    const apiKey = req.headers['x-api-key'];
    const internalKey = process.env.INTERNAL_API_KEY;

    // 只有在生產環境或明確設定時才強制執行，避免影響你本地開發
    if (!internalKey) {
        return next();
    }

    if (!apiKey || apiKey !== internalKey) {
        console.warn(`🚫 [Security] 未經授權的存取嘗試: ${req.method} ${req.url}`);
        return res.status(401).json({ success: false, error: "Unauthorized: Invalid API Key" });
    }
    next();
};

const portStr: string = String(process.env.TUS_SERVER_PORT);
const PORT = parseInt(portStr || "3003", 10); // 我們讓這個服務預設跑在 3003 port
const HOST = "0.0.0.0"; // 這樣不管是 localhost 還是 Docker 內部網路都能連上，而且前端連線時用的還是 localhost:3003（因為我們在 docker-compose.yml 中做了 port mapping）
const WORKER_WEBHOOK_URL = process.env.IFC_FRAGS_CONVERT_WORKER_WEBHOOK_URL 
    ? `http://${process.env.IFC_FRAGS_CONVERT_WORKER_WEBHOOK_URL}/webhook/convert` 
    : 'http://localhost:3005/webhook/convert';const TUS_Server_URL = `${process.env.TUS_SERVER_HOST}:${PORT}`;

// // 初始化 Socket.io 並設定 Socket 關聯的 CORS Policy
// const allowedOrigins = [
//   `http://${HOST}:${PORT}`,        // 前端開發網址
//   `http://${process.env.TUS_SERVER_URL}:${PORT}`,     // 另一個前端
//   `http://${process.env.TARGET_HOST}:${PORT}`,     // 從環境變數讀取的 TUS 網址
// ];
// 1. 從環境變數讀取字串，如果沒設定則給予預設值 (建議至少留個 localhost)
const originsStr:string = process.env.ALLOWED_ORIGINS || 'https://modellibrary.bies-cloud.com';

// 2. 將字串轉為陣列
const allowedOrigins = originsStr.split(',').map(origin => origin.trim());

const io = new SocketServer(server, {
    cors: {
        origin: function (origin:any, callback:any) {
            // 如果請求沒有 origin (例如伺服器對伺服器通訊或 Postman) 
            // 或是 origin 在白名單內，就放行
            if (!origin || allowedOrigins.includes(origin)) {
                callback(null, true);
            } else {
                console.warn(`🚫 [CORS] 拒絕來自非白名單的連線: ${origin}`);
                callback(new Error('Not allowed by CORS'));
            }
        },
        methods: ["GET", "POST", "OPTIONS"],
        credentials: true
    }
});

// 監聽 Socket 連線 (Debug 用)
io.on('connection', (socket:any) => {
    const userId = socket.handshake.query.userId;

    if(userId) {
        socket.join(userId); //加入專屬房間
        console.log(`🔌 [Socket] 使用者 ${userId} 已連線並加入房間`);
    }else {
        console.log(`🔌 [Socket] 未登入使用者連線: ${socket.id}`);
    }
});

// 設定 Tus 儲存方式 (存到 MinIO)
// 新版的 @tus/s3-store 中，你通常不需要手動 new S3Client() 再傳進去，
// 而是直接在 s3ClientConfig 物件中傳入 AWS 的設定參數，S3Store 內部會幫你建立 Client
const S3_Endpoint_str = `http://${process.env.S3_HOST}:${process.env.S3_PORT}`;  // 需要加上 http:// 避免host&port 在S3Store 類別中錯誤使用
const s3Client = new S3Client({
    region: process.env.S3_REGION,
    endpoint: S3_Endpoint_str,
    credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY!,
        secretAccessKey: process.env.S3_SECRET_KEY!,
    },
    forcePathStyle: true,
});

const copyUploadedFileToViewerBucket = async (fileId: string) => {
    const uploadBucket = process.env.S3_UPLOADASSETS_BUCKET!;
    const viewerBucket = process.env.S3_VIEWER_ASSETS_BUCKET!;

    await s3Client.send(new CopyObjectCommand({
        Bucket: viewerBucket,
        CopySource: `${uploadBucket}/${encodeURIComponent(fileId)}`,
        Key: fileId,
    }));
};

const store = new S3Store({
    partSize: 10 * 1024 * 1024, // 設定每個分片 10MB (保護上傳記憶體穩定)
    s3ClientConfig:{
        bucket: process.env.S3_UPLOADASSETS_BUCKET!,
        region: process.env.S3_REGION,
        endpoint: S3_Endpoint_str ,
        credentials: {
            accessKeyId: process.env.S3_ACCESS_KEY!,
            secretAccessKey: process.env.S3_SECRET_KEY!,
        },
        forcePathStyle: true, // MinIO 必須設為 true
    } 
});

// 建立 Tus Server 實例
const tusServer = new Server({
    path: '/files',
    datastore: store,
    respectForwardedHeaders: true,
    // 命名函式
    namingFunction: (req, metadata) => {
        const id = nanoid(12);
        const originalName = metadata?.name;

        if(originalName){
            // 為了避免中文或特殊符號讓 MinIO 儲存時產生編碼問題，可以做個簡單的編碼
            // 或是你也可以選擇只抓副檔名。這裡我們採用「隨機碼_原始檔名」的格式
            // 存進 MinIO 就會變成類似：V1StGXR8_z_my_building.ifc
            
            // 替換掉可能造成 URL 路徑解析錯誤的特殊字元 (例如空白換成底線)
            const safeName = originalName.replace(/[^a-zA-Z0-9.\-_]/g, '_'); 
            return `${id}+${safeName}`;
        }

        return id;
    }
});
// Redis 連線 (給 QueueEvents 用)
const redisEndpoint: string = String(process.env.REDIS_HOST || 'localhost');
const redisportStr: string = String(process.env.REDIS_PORT);
const redisConnection = new IORedis({
    host: redisEndpoint,
    port: parseInt(redisportStr || "6379"),
    username: process.env.REDIS_USERNAME || 'default', // Redis 6.0+ 預設帳號通常是 default
    password: process.env.REDIS_PASSWORD,              // 你的 Redis 密碼
    maxRetriesPerRequest: null,
});
// 初始化 QueueEvents 監聽器
// 自動連上 Redis，並監聽所有動靜。
// 名稱按照ENV 設置，tus-server 和 ifc-convert-frags-server 同步
const ifcConversionQueue = process.env.IFC_CONVERSION_Q || 'ifc-conversion-queue';
const queueEvents = new QueueEvents(ifcConversionQueue , { 
    connection: redisConnection 
});
// 建立 Queue 實例，讓我們可以操作與查詢 Redis 裡的任務
const conversionQueue = new Queue(ifcConversionQueue, { 
    connection: redisConnection 
});

// 監聽「進度更新」事件
queueEvents.on('progress', ({ jobId, data }:{jobId:string, data:any}) => {
    const taskInfo = activeTasksMap.get(jobId);
    const userId = taskInfo?.userId;

    if(userId){
        io.to(userId).emit('conversion-progress' , {
            fileId: jobId,
            progress: data
        });
        console.log(`📊 [Redis] Job: ${jobId} user: ${userId} 進度: ${data}%`); // Debug 用
    } else{
        // 💡 優化：如果查無 userId (可能伺服器剛重啟)，啟動 Fallback 全頻廣播
        // 反正前端有防呆，不會互相干擾
        io.emit('conversion-progress', { fileId: jobId, progress: data });
        console.log(`📊 [Redis] Job: ${jobId} 找不到Uesr: ${userId} 進度: ${data}% 不廣播!!s`);
    }
});
// 先定義 API 路由 (給 Worker 用的)
// 這樣可以確保 Tus 的 handle 不會對這個請求造成任何干擾
app.post('/notify/done', authMiddleware, (req:any, res:any)=> {
    // Debug 用：印出收到的東西，確認 body 是否存在
    console.log("📨 [Debug] /notify/done headers:", req.headers['content-type']);
    console.log("📨 [Debug] /notify/done body:", req.body);
    // 防呆：如果 body 還是 undefined (極端情況)，手動處理或報錯
    if (!req.body) {
        console.error("❌ [Error] req.body is undefined!");
        return res.status(400).json({ error: "No body received" });
    }
    const { fileKey, fileName, status, message, size, userId:bodyUserId } = req.body;
    
    // 💡 優先使用 activeTasksMap 裡的 userId，找不到才用 body 裡的
    const taskInfo = activeTasksMap.get(fileKey);
    const userId = taskInfo?.userId || bodyUserId;

    const payload = {
        fileName,
        fileId: fileKey, 
        status, 
        message, 
        size,
        fragUrl: `/viewer-assets/${fileKey}`,
        ifcUrl: `/uploadassets/${fileKey}`
    };

    console.log(`📣 [Tus] 收到 Worker 完成通知: ${fileName} (${status})`);

    // 透過 WebSocket 通知前端
    if (userId) {
        io.to(userId).emit('conversion-complete', payload);
        console.log(`User: ${userId} 的任務完成 釋放任務tus任務佇列`);
    } else {
        // 沒有 userId，就不回傳 保證其他人不會師到不屬於他的通知
        // io.emit('conversion-complete', payload);
        console.log(`[Fallback] 找不到該任務的user,使用全頻廣播通知`);
    }

    // 清理佇列 不管有沒有通知成功
    activeTasksMap.delete(fileKey);

    res.json({ received: true });
});

// 監聽「上傳完成」事件
tusServer.on(EVENTS.POST_FINISH, async(req:any, res:any, upload:any) => {
    const fileId = upload.id;
    // 取得檔名 (Uppy 預設會把檔名放在 metadata.filename)
    const fileName = upload.metadata?.filename;
    const userId = upload.metadata?.userid;
    const userCategory = upload.metadata?.category;
    const rawTeamId = upload.metadata?.teamId;
    // 將task歸納到他屬於的userId內
    if(userId) {
        activeTasksMap.set(fileId, { userId, timestamp: Date.now() });
    }

    console.log("DEBUG: metadata received:", upload.metadata);

    if (fileName) {
        console.log(`✅ [Tus] 上傳成功: ${fileName}(ID: ${fileId})`);
        
        const extension = `.${fileName.toLowerCase().split('.').pop()}`;
        // 🚀 2. 關鍵防呆：前端如果傳 "null" (字串)，我們要轉回真正的 null，代表個人空間
        const teamId = (rawTeamId && String(rawTeamId) !== "null" && String(rawTeamId) !== "undefined") 
            ? String(rawTeamId) 
            : null;
        try{
            // 只有 IFC 需要設為 processing
            const isIfc = extension === '.ifc';
            const isFrag = extension === '.frag';

            if(isFrag) {
                await copyUploadedFileToViewerBucket(fileId);
                console.log(`📦 [Tus] Frag 直接複製到 Viewer Bucket: ${fileId}`);
            }

            const newFile = await prisma.fileRecord.create({
                data: {
                    name: fileName,
                    fileId: fileId,
                    category: userCategory,
                    extension: extension,
                    size: upload.size ? upload.size.toString() : "0",
                    // IFC 進入加工狀態，其餘檔案直接「已完成」
                    status: isIfc ? 'processing' : 'completed',
                    viewerFileId: isFrag ? fileId : null,
                    uploaderId: userId,
                    teamId: teamId
                }
            })
            console.log(`📦 [Tus] 簽收: ${fileName} (${userCategory}) -> ${isIfc ? '送往加工廠' : '直接入庫'}`);
            
            if(isIfc){
                console.log(`📞 [Tus] 正在通知 Worker 處理: ${fileName}...`);
                axios.post(WORKER_WEBHOOK_URL, {
                    fileKey:fileId,
                    fileName:fileName,
                    dbId: newFile.id,
                    userId: userId
                });
                console.log(`📨 [Tus] 通知 Worker 成功！`);
            } else {
                // 非 IFC 檔案直接透過 Socket 告訴前端「傳好了」
                // 這樣前端的進度條會立刻變色完成
                io.emit('conversion-complete', {
                    fileName: fileName,
                    fileId: fileId,
                    status: 'success'
                });
            }
        }catch(err: any){
            if(err) console.error(`❌ [Tus] DB 寫入或通知失敗:`, err.message);

        }
    }
});

app.get('/health', (req: any, res: any) => {
    const path = req.url || "none"; // 例如 "/api/hello?name=next"
    // console.info(`[Tus] Receive health check ... ${path}`);
    res.json({
        success: true,
        message: "OK",
        timestamp: new Date().toISOString()
    });
});

app.get('/api/tasks/status', authMiddleware, async (req, res) => {
    const userId = req.query.userId;
    // 或是用 fileId: const fileId = req.query.fileId;

    if (!userId) return res.status(400).json({ error: "Missing userId" });

    try {
        // 1. 去資料庫查詢該使用者「正在處理中」或「發生錯誤」的任務
        const activeTasks = await prisma.fileRecord.findMany({
            where: {
                uploaderId: userId as string,
                status: { in: ['processing', 'error'] }
            }
        });

        // 2. 去 Redis (BullMQ) 查目前的精準 % 數
        const tasksWithProgress = await Promise.all(activeTasks.map(async (task) => {
            // 用 task.fileId (也就是我們的 jobId) 去 Redis 抓取該任務的詳細資訊
            const job = await conversionQueue.getJob(task.fileId);
            
            return {
                ...task,
                // 如果任務還在 Redis 裡，就抓出當前進度；如果不在了，就給 0
                progress: job ? job.progress : 0 
            };
        }));

        res.json({ success: true, data: tasksWithProgress });
    } catch (error) {
        console.error("Fetch status error:", error);
        res.status(500).json({ error: "Failed to fetch task status" });
    }
});
app.post('/api/tasks/retry', authMiddleware, async (req, res) =>{
    const { fileId, userId, priority = 10 } = req.body;

    if(!fileId || !userId){
        return res.status(400).json({ success: false, error: "缺少必要參數" });
    }

    try{
        // 1. 去資料庫驗證該檔案是否真的存在且屬於該使用者
        const fileRecord = await prisma.fileRecord.findUnique({
            where: { fileId: fileId }
        });
        if (!fileRecord) return res.status(404).json({ success: false, error: "找不到該檔案紀錄" });
        if (fileRecord.uploaderId !== userId) return res.status(403).json({ success: false, error: "無權限操作" });
        if (fileRecord.extension !== '.ifc') return res.status(400).json({ success: false, error: "非 IFC 檔案無法轉檔" });
        
        // 2. 將資料庫狀態重置為 processing，並清空錯誤訊息
        await prisma.fileRecord.update({
            where: { fileId: fileId },
            data: {
                status: 'processing',
                errorMessage: null
            }
        });

        // 3. 關鍵動作：將這個重試的任務重新註冊進 Map，這樣 Socket 才能把進度推給該使用者！
        activeTasksMap.set(fileId, { userId, timestamp: Date.now() });

        // 4. 由 Tus Server 透過內網穿透呼叫 IFC Converter Worker
        await axios.post(WORKER_WEBHOOK_URL, {
            fileKey: fileRecord.fileId,
            fileName: fileRecord.name,
            dbId: fileRecord.id,
            userId: userId,
            priority: priority // 預留的優先權設定
        });

        console.log(`♻️ [Tus Server] 收到重試請求，已將 ${fileRecord.name} 重新派發給 Worker`);
        res.json({ success: true });
    } catch (error) {
        console.error("❌ [Tus Server] 重試派發失敗:", error);
        res.status(500).json({ success: false, error: "無法重新排隊，請稍後再試" });
    }
});

// 掛載上傳路由
// 注意：Tus 需要處理 HEAD, PATCH, POST 等請求，所以用 app.all
// 處理 "建立上傳" (POST /files)
// 處理 "後續操作" (PATCH/HEAD/DELETE /files/xxxx)
app.post(/files/, (req: any, res: any) => {
    const path = req.url || "none"; // 例如 "/api/hello?name=next"
    console.log(`[Tus] Receive files requestion POST ... ${path}`);
    tusServer.handle(req, res);
});
app.patch(/files/, (req: any, res: any) => {
    const path = req.url || "none"; // 例如 "/api/hello?name=next"
    console.log(`[Tus] Receive files requestion PATCH ... ${path}`);
    tusServer.handle(req, res);
});
app.head(/files/, (req: any, res: any) => {
    const path = req.url || "none"; // 例如 "/api/hello?name=next"
    console.log(`[Tus] Receive files requestion HEAD ... ${path}`);
    tusServer.handle(req, res);
});
app.delete(/files/, (req: any, res: any) => {
    const path = req.url || "none"; // 例如 "/api/hello?name=next"
    console.log(`[Tus] Receive files requestion DELETE ... ${path}`);
    tusServer.handle(req, res);
});

// 拒絕其他所有請求 (GET, POST, etc.)
app.all(/(.*)/, (req, res) => {
    res.status(403).json({
        success: false,
        message: `${process.env.TUS_SERVER_HOST} 無法受理此請求 (Request Not Accepted)`,
        timestamp: new Date().toISOString()
    });
});

// 啟動伺服器
server.listen(PORT, HOST, () => {
    console.log(`--------------------------------------------------`);
    console.log(`📂 Connecting to MinIO at: ${process.env.S3_ENDPOINT}`);
    console.log(`📦 Target Bucket: ${process.env.S3_UPLOADASSETS_BUCKET }`);
    console.log(`🔗 Worker Webhook Target: ${WORKER_WEBHOOK_URL}`);
    console.log(`🚀 Tus Server + Socket running on http://localhost:${PORT}`);
    console.log(`--------------------------------------------------`);
});
