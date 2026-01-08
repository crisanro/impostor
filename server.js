import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// Serve Static Files (Vite Build)
app.use(express.static(path.join(__dirname, 'dist')));

// API Endpoint for AI Word Generation
// API Endpoint for AI Word Generation
app.post('/api/generate-word', async (req, res) => {
    try {
        const { hostUid, topic } = req.body;

        if (!hostUid) {
            return res.status(400).json({ error: "Falta Host UID" });
        }

        // Importar Firestore Admin (agregar al inicio del archivo)
        const { initializeApp: initializeAdminApp, cert } = await import('firebase-admin/app');
        const { getFirestore: getAdminFirestore } = await import('firebase-admin/firestore');

        // Inicializar Admin SDK si no está inicializado
        let adminDb;
        try {
            const admin = await import('firebase-admin');
            if (!admin.apps.length) {
                // Usar credenciales por defecto en producción (Google Cloud)
                admin.initializeApp();
            }
            adminDb = admin.firestore();
        } catch (e) {
            console.error("Error inicializando Admin SDK:", e);
            return res.status(500).json({ error: "Error de configuración del servidor" });
        }

        // Obtener la API Key del usuario desde Firestore (server-side)
        const userDoc = await adminDb.collection('users').doc(hostUid).get();

        if (!userDoc.exists || !userDoc.data().apiKey) {
            return res.status(400).json({ error: "Host sin API Key configurada" });
        }

        const apiKey = userDoc.data().apiKey;

        // Initialize Gemini with User's Key
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-exp" });

        const prompt = `
            Genera un objeto JSON con una palabra secreta y una pista para un juego de adivinanzas (tipo Spyfall/Impostor).
            IMPORTANTE: La pista debe ser UNA SOLA PALABRA, abstracta y difícil. No regales la respuesta.
            
            Tema: ${topic || "Cultura General Latinoamericana"}

            Formato JSON requerido:
            {
                "word": "Palabra Adivinar",
                "hint": "PistaUnaSolaPalabra",
                "category": "CategoríaDelTema"
            }
            
            Solo devuelve el JSON, nada de texto extra.
        `;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        let text = response.text();

        // Clean markdown code blocks if present
        text = text.replace(/```json/g, '').replace(/```/g, '').trim();

        const json = JSON.parse(text);
        res.json(json);

    } catch (error) {
        console.error("AI Error:", error);
        res.status(500).json({ error: "Error generando palabra con IA", details: error.message });
    }
});

// SPA Fallback
app.get(/.*/, (req, res) => {
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
