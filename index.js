const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin'); 
const mongoose = require('mongoose'); 
const compression = require('compression'); 
const rateLimit = require('express-rate-limit'); 
const helmet = require('helmet'); // 🚀 NAYA: Ultimate API Security
const https = require('https'); 
const http = require('http'); 
require('dotenv').config();

const app = express();

// ==========================================
// 🚀 0. PERFORMANCE & SECURITY MIDDLEWARES
// ==========================================

// 🛡️ Trust Proxy: Render/Railway (Proxy servers) ke peeche Rate Limiter ko sahi IP batane ke liye
app.set('trust proxy', 1);

// 🛡️ Helmet: HTTP headers ko secure karta hai taaki hackers system ka pata na laga sakein
app.use(helmet());

// 🛡️ Dynamic CORS Security: Localhost (Dev) aur Vercel (Prod) dono ke liye
const allowedOrigins = process.env.NODE_ENV === 'production' 
    ? ['https://edufills.com', 'https://www.edufills.com', 'https://edu-fill.vercel.app/'] // 🚨 Yahan apna asli Vercel URL zaroor daalein!
    : ['http://localhost:5173', 'http://localhost:3000', 'http://localhost:5174']; // Local React/Vite ports

app.use(cors({
    origin: function (origin, callback) {
        // Agar origin undefined hai (jaise Postman ya Server-to-Server call) ya allowed list me hai
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error('❌ Blocked by EduFill CORS Security'));
        }
    },
    credentials: true
}));

app.use(express.json());
app.use(compression()); // Gzip Compression (70% smaller response)

// 🛡️ Rate Limiter: Max 500 requests per 15 minutes per IP
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 500, 
    message: { error: "Too many requests from this IP, please try again after 15 minutes." }
});
app.use('/api/', limiter);

// ==========================================
// 🚀 1. Firebase Admin Setup
// ==========================================
let db;
try {
    const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT 
        ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT) 
        : require(process.env.GOOGLE_APPLICATION_CREDENTIALS);

    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    db = admin.firestore(); 
    console.log("🔥 Firebase Admin Connected!");
} catch (error) {
    console.error("❌ Firebase Setup Error:", error.message);
}

// ==========================================
// 🚀 2. MongoDB Atlas Setup (Secure)
// ==========================================
const MONGO_URI = process.env.MONGO_URI;

mongoose.set('strictQuery', false);

if (MONGO_URI) {
    mongoose.connect(MONGO_URI)
        .then(() => console.log("🔥 MongoDB Atlas Connected Successfully!"))
        .catch((err) => console.error("❌ MongoDB Connection Error:", err.message));
} else {
    console.error("❌ MONGO_URI is missing in environment variables!");
}

// ==========================================
// 🚀 3. Routes
// ==========================================
app.get('/', (req, res) => {
    res.status(200).send("EduFill Backend is Secure, Live & Optimized! 🚀");
});

const collegeRoutes = require('./routes/collegeRoutes');
app.use('/api/colleges', collegeRoutes);

// ==========================================
// 🚀 4. Server Start & ANTI-SLEEP Mechanism
// ==========================================
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
    console.log(`🚀 Server is running on port ${PORT} in ${process.env.NODE_ENV || 'development'} mode`);

    const SERVER_URL = process.env.SERVER_URL || `http://localhost:${PORT}`; 
    
    // Anti-Sleep Ping sirf Production (Render) par chalega, localhost dev par shor nahi machayega
    if (SERVER_URL && process.env.NODE_ENV === 'production') {
        setInterval(() => {
            const pingModule = SERVER_URL.startsWith('https') ? https : http;
            
            pingModule.get(SERVER_URL, (res) => {
                console.log(`[Anti-Sleep Ping] Server Status: ${res.statusCode} at ${new Date().toLocaleTimeString()}`);
            }).on('error', (err) => {
                console.error(`[Anti-Sleep Ping] Failed: ${err.message}`);
            });
        }, 10 * 60 * 1000); // 10 minutes
        
        console.log(`⏱️ Anti-Sleep Self-Pinging initialized for: ${SERVER_URL}`);
    }
});