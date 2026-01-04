import React, { useState, useEffect } from 'react';
import { db, auth, googleProvider } from './firebase';
import { signInWithPopup, signOut, onAuthStateChanged } from "firebase/auth";
import {
    doc, setDoc, getDoc, onSnapshot, updateDoc, arrayUnion, arrayRemove, deleteDoc, serverTimestamp
} from 'firebase/firestore';
import { QRCodeSVG } from 'qrcode.react';
import { defaultWordBank } from './words';

function App() {
    // --- STATE ---
    // Auth & User
    const [authUser, setAuthUser] = useState(null); // Google User
    const [localUser, setLocalUser] = useState(null); // Game User { uid, nombre } (Anonymous)

    // Config (Persisted in users/{uid})
    const [geminiKey, setGeminiKey] = useState('');
    const [customPrompt, setCustomPrompt] = useState('');

    // Flow
    const [viewMode, setViewMode] = useState('HOME');
    const [roomCode, setRoomCode] = useState('');
    const [roomData, setRoomData] = useState(null);

    // Forms
    const [nombreInput, setNombreInput] = useState('');
    const [joinCodeInput, setJoinCodeInput] = useState('');

    // Create Room Config
    const [impostorCount, setImpostorCount] = useState(1);
    const [pistasActivas, setPistasActivas] = useState(true);
    const [gameMode, setGameMode] = useState('ONLINE'); // 'ONLINE' | 'DEVICE'

    // Device Mode State
    const [localPlayers, setLocalPlayers] = useState([]); // [{uid, nombre}] for device mode
    const [currentTurnIndex, setCurrentTurnIndex] = useState(0); // For pass & play
    const [showRole, setShowRole] = useState(false);
    const [revealRole, setRevealRole] = useState(false); // For Online Mode press-to-reveal

    // --- EFFECT: Auth Listener ---
    useEffect(() => {
        const unsubscribe = onAuthStateChanged(auth, async (u) => {
            if (u) {
                setAuthUser(u);
                const docSnap = await getDoc(doc(db, "users", u.uid));
                if (docSnap.exists()) {
                    setGeminiKey(docSnap.data().apiKey || '');
                }
            } else {
                setAuthUser(null);
            }
        });
        return () => unsubscribe();
    }, []);

    // Reset Turn Index on New Game (Word Change)
    useEffect(() => {
        setCurrentTurnIndex(0);
    }, [roomData?.gameData?.palabra]);

    // --- EFFECT: URL Params & Session ---
    useEffect(() => {
        // Check URL for room code
        const params = new URLSearchParams(window.location.search);
        const codeParam = params.get('room');
        if (codeParam) {
            setJoinCodeInput(codeParam);
            // setViewMode('JOIN'); // Don't change mode, just prefill Home input
        }

        // Restore Session
        const savedSession = localStorage.getItem('impostor_session_v4');
        if (savedSession) {
            try {
                const sess = JSON.parse(savedSession);
                if (sess.uid && sess.nombre) {
                    setLocalUser({ uid: sess.uid, nombre: sess.nombre });
                    if (sess.roomCode) {
                        setRoomCode(sess.roomCode);
                        subscribeToRoom(sess.roomCode, { uid: sess.uid });
                    }
                }
            } catch (e) { console.error(e); }
        }
    }, []);

    // --- ACTIONS ---

    const handleGoogleLogin = async () => {
        try {
            await signInWithPopup(auth, googleProvider);
        } catch (error) {
            alert("Error login: " + error.message);
        }
    };

    const handleLogout = () => signOut(auth);

    const saveApiKey = async () => {
        if (!authUser) return;
        await setDoc(doc(db, "users", authUser.uid), { apiKey: geminiKey }, { merge: true });
        alert("API Key Guardada");
    };

    const createLoginLocal = (name) => {
        const uid = Math.random().toString(36).substring(7);
        const u = { uid, nombre: name };
        setLocalUser(u);
        return u;
    };

    const saveSession = (u, code) => {
        localStorage.setItem('impostor_session_v4', JSON.stringify({
            uid: u.uid, nombre: u.nombre, roomCode: code || ''
        }));
    };

    const clearSession = () => {
        localStorage.removeItem('impostor_session_v4');
        setRoomCode('');
        setRoomData(null);
        setViewMode('HOME');
        // Don't clear localUser if they just left a room? optional.
    };

    // --- ROOM LOGIC ---

    const crearSala = async () => {
        if (!authUser) return alert("Debes iniciar sesión para crear sala.");

        try {
            const hostName = authUser.displayName || "Host";
            const code = Math.random().toString(36).substring(2, 6).toUpperCase();

            // Ensure Host uses their Google Name if not already set locally
            let u = localUser;
            if (!u || (authUser && u.nombre !== authUser.displayName)) {
                // Prefer Google Identity for Host consistency
                u = { uid: authUser.uid, nombre: authUser.displayName };
                setLocalUser(u);
            } else if (!u) {
                u = createLoginLocal(hostName);
            }

            await setDoc(doc(db, "salas", code), {
                host: u.uid,
                createdAt: serverTimestamp(), // Cleanup timestamp
                estado: "LOBBY",
                mode: gameMode, // ONLINE or DEVICE
                jugadores: [{ uid: u.uid, nombre: u.nombre, votos: 0, estado: 'vivo', voto: null }], // Online players
                localPlayers: gameMode === 'DEVICE' ? [{ uid: u.uid, nombre: u.nombre, estado: 'vivo' }] : [],
                impostores: [],
                config: { pistasActivas, impostorCount, customPrompt }, // NO KEY HERE
                gameData: { palabra: "", categoria: "", pista: "" },
                lastResult: null
            });

            setRoomCode(code);
            saveSession(u, code);
            subscribeToRoom(code, u);
            setViewMode('LOBBY'); // Force UI transition
        } catch (error) {
            console.error("Error creando sala:", error);
            alert("Error creando sala: " + error.message + "\n\nRevisa la consola (F12) para más detalles.");
        }
    };

    const unirseSala = async () => {
        if (!nombreInput && !localUser) return alert("Nombre requerido");
        if (!joinCodeInput) return alert("Código requerido");

        try {
            const code = joinCodeInput.toUpperCase();
            const roomRef = doc(db, "salas", code);
            const docSnap = await getDoc(roomRef);

            if (!docSnap.exists()) return alert("Sala no existe");

            // If Device Mode, joining via phone IS NOT ALLOWED?
            // "Multi-device" means everyone joins. "Device" means only Host controls.
            // If room is DEVICE mode, maybe viewers can see status but not play?
            // Let's assume standard Join is for Online mode. 
            // If Device mode, maybe they just join as spectators? 
            // For now, let's treat Join as "Becoming a player in array".

            const u = localUser || createLoginLocal(nombreInput);

            // Only add to players if Online Mode
            if (docSnap.data().mode !== 'DEVICE') {
                const currentPlayers = docSnap.data().jugadores || [];
                const exists = currentPlayers.some(p => p.uid === u.uid);
                if (!exists) {
                    await updateDoc(roomRef, {
                        jugadores: arrayUnion({ uid: u.uid, nombre: u.nombre, votos: 0, estado: 'vivo', voto: null })
                    });
                }
            }

            setRoomCode(code);
            saveSession(u, code);
            subscribeToRoom(code, u);
        } catch (e) {
            alert("Error: " + e.message);
        }
    };

    const subscribeToRoom = (code, u) => {
        onSnapshot(doc(db, "salas", code), (snap) => {
            if (!snap.exists()) {
                clearSession();
                alert("Sala cerrada");
            } else {
                setRoomData(snap.data());
            }
        });
    };

    // --- GAME ACTIONS ---

    const addLocalPlayer = async (name) => {
        if (!name.trim()) return;
        const uid = Math.random().toString(36).substring(7);
        const newP = { uid, nombre: name, estado: 'vivo' };
        await updateDoc(doc(db, "salas", roomCode), {
            localPlayers: arrayUnion(newP)
        });
        setNombreInput(""); // reuse input
    };

    const generarPalabra = async (salaConfig, userKey) => {
        // Try AI first
        if (userKey) {
            try {
                const res = await fetch('/api/generate-word', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        apiKey: userKey,
                        topic: salaConfig.customPrompt || "Cultura General"
                    })
                });
                if (res.ok) {
                    const data = await res.json();
                    return { palabra: data.word, pista: data.hint, categoria: "IA: " + (data.category || salaConfig.customPrompt) };
                }
            } catch (e) {
                console.error("AI Failed", e);
                alert("Error conectando con la IA (backend no disponible o error de red). Usando palabras por defecto.");
            }
        }

        // Fallback
        const cats = Object.keys(defaultWordBank);
        const cat = cats[Math.floor(Math.random() * cats.length)];
        const item = defaultWordBank[cat][Math.floor(Math.random() * defaultWordBank[cat].length)];
        return { palabra: item.word, pista: item.hint, categoria: cat };
    };

    const iniciarPartida = async () => {
        const players = roomData.mode === 'DEVICE' ? roomData.localPlayers : roomData.jugadores;
        console.log("Intentando iniciar partida, jugadores:", players.length);
        if (players.length < 3) {
            const faltan = 3 - players.length;
            return alert(`Necesitas mínimo 3 jugadores para iniciar.\n(Faltan ${faltan})`);
        }

        // Generate Word - Use LOCAL geminiKey state if Host
        const gameData = await generarPalabra(roomData.config, geminiKey);

        // Assign Roles
        const pIds = players.map(p => p.uid);
        const imps = [];
        let count = roomData.config.impostorCount || 1;

        // Safety check
        if (count >= players.length) count = 1;

        while (imps.length < count) {
            const r = pIds[Math.floor(Math.random() * pIds.length)];
            if (!imps.includes(r)) imps.push(r);
        }

        // Select Starting Player
        const startingPlayer = players[Math.floor(Math.random() * players.length)].nombre;

        const updates = {
            estado: "JUEGO",
            impostores: imps,
            gameData: { ...gameData, startingPlayer },
            lastResult: null,
            // Reset states
            [roomData.mode === 'DEVICE' ? 'localPlayers' : 'jugadores']: players.map(p => ({ ...p, estado: 'vivo', votos: 0, voto: null }))
        };

        await updateDoc(doc(db, "salas", roomCode), updates);
    };

    // --- RENDER HELPERS ---

    if (viewMode === 'HOME' && !roomData) {
        return (
            <div className="card">
                <h1>🕵️ EL IMPOSTOR</h1>

                {!authUser ? (
                    <div style={{ marginBottom: 20 }}>
                        <p>Inicia sesión para crear salas con IA</p>
                        <button onClick={handleGoogleLogin} style={{ background: '#4285F4' }}>Ingresar con Google</button>
                    </div>
                ) : (
                    <div style={{ marginBottom: 20, textAlign: 'left', background: '#333', padding: 10, borderRadius: 8 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                            <span>Hola, {authUser.displayName}</span>
                            <button onClick={handleLogout} style={{ padding: '2px 8px', fontSize: '0.8em' }}>Salir</button>
                        </div>
                        <div style={{ marginTop: 10 }}>
                            <label>Gemini API Key (Opcional):</label>
                            <input type="password" value={geminiKey} onChange={e => setGeminiKey(e.target.value)} placeholder="sk-..." />
                            <button onClick={saveApiKey} style={{ marginTop: 5, width: '100%', fontSize: '0.8em' }}>Guardar Key</button>
                        </div>
                    </div>
                )}

                <div style={{ borderTop: '1px solid #555', paddingTop: 20 }}>
                    <h3>Unirse a Partida</h3>
                    <input placeholder="Tu Nombre" value={nombreInput} onChange={e => setNombreInput(e.target.value)} />
                    <input placeholder="Código Sala" value={joinCodeInput} onChange={e => setJoinCodeInput(e.target.value)} style={{ marginTop: 5 }} />
                    <button onClick={unirseSala} style={{ marginTop: 10, background: '#28a745' }}>UNIRSE</button>
                </div>

                {authUser && (
                    <div style={{ marginTop: 30 }}>
                        <button onClick={() => setViewMode('CREATE')} style={{ background: 'transparent', border: '1px solid #fff' }}>CREAR NUEVA SALA</button>
                    </div>
                )}
            </div>
        );
    }

    if (viewMode === 'CREATE') {
        return (
            <div className="card">
                <h2>Configurar Sala</h2>

                <div style={{ margin: '20px 0' }}>
                    <label>Modo de Juego:</label>
                    <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 5 }}>
                        <button
                            onClick={() => setGameMode('ONLINE')}
                            style={{ background: gameMode === 'ONLINE' ? '#ff9800' : '#444', flex: 1 }}
                        >Online (Multi-celular)</button>
                        <button
                            onClick={() => setGameMode('DEVICE')}
                            style={{ background: gameMode === 'DEVICE' ? '#ff9800' : '#444', flex: 1 }}
                        >Un solo celular</button>
                    </div>
                </div>

                {gameMode === 'ONLINE' && (
                    <input placeholder="Tu Nombre de Jugador" value={nombreInput} onChange={e => setNombreInput(e.target.value)} />
                )}

                <div style={{ marginTop: 20 }}>
                    <label>Tema de Palabras (IA):</label>
                    <input placeholder="Ej: Anime, Fútbol, Star Wars..." value={customPrompt} onChange={e => setCustomPrompt(e.target.value)} />
                    <small style={{ color: '#aaa' }}>Si dejas vacío, usa "Cultura General". Requiere API Key guardada.</small>
                </div>



                <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
                    <button onClick={crearSala} style={{ background: '#28a745', flex: 1 }}>CREAR</button>
                    <button onClick={() => setViewMode('HOME')} style={{ background: '#666', flex: 1 }}>CANCELAR</button>
                </div>
            </div>
        );
    }

    // --- IN LOBBY/GAME ---
    if (!roomData) return <div className="card">Cargando...</div>;

    const players = roomData.mode === 'DEVICE' ? roomData.localPlayers : roomData.jugadores;
    const isHost = roomData.host === (localUser?.uid || authUser?.uid); // Loose check logic
    // Actually, persistence stores uid in localUser.

    // Header
    const Header = () => (
        <div style={{ borderBottom: '1px solid #444', paddingBottom: 10, marginBottom: 10, display: 'flex', justifyContent: 'space-between' }}>
            <strong>{roomCode}</strong>
            <button onClick={() => {
                // If host
                if (roomData.host === localUser?.uid) deleteDoc(doc(db, "salas", roomCode));
                clearSession();
            }} style={{ background: '#d32f2f', padding: '5px 10px', fontSize: '0.7em', width: 'auto' }}>Salir</button>
        </div>
    );

    // LOBBY
    if (roomData.estado === "LOBBY") {
        const shareUrl = `${window.location.origin}/?room=${roomCode}`;
        return (
            <div className="card">
                <Header />
                <div className="qrcode-container">
                    <QRCodeSVG value={shareUrl} size={150} />
                </div>
                <p style={{ fontSize: '0.8em', color: '#aaa' }}>Escanea para unirte (Online)</p>

                {roomData.mode === 'DEVICE' ? (
                    <div style={{ marginTop: 20, borderTop: '1px solid #444', paddingTop: 10 }}>
                        <h3>Jugadores Locales</h3>
                        <ul style={{ textAlign: 'left', background: '#222', padding: 10, marginBottom: 10 }}>
                            {players.map(p => <li key={p.uid}>{p.nombre}</li>)}
                        </ul>
                        {isHost && (
                            <div style={{ display: 'flex', gap: 5 }}>
                                <input placeholder="Nombre Jugador" value={nombreInput} onChange={e => setNombreInput(e.target.value)} />
                                <button onClick={() => addLocalPlayer(nombreInput)} style={{ width: 'auto', background: '#2196f3' }}>+</button>
                            </div>
                        )}
                    </div>
                ) : (
                    <div style={{ marginTop: 20 }}>
                        <h3>Jugadores ({players.length})</h3>
                        <ul style={{ textAlign: 'left', background: '#222', padding: 10 }}>
                            {players.map(p => <li key={p.uid}>{p.nombre}</li>)}
                        </ul>
                    </div>
                )}

                {isHost && (
                    <div style={{ marginTop: 20, borderTop: '1px solid #444', paddingTop: 10 }}>
                        <label>Impostores: <b>{roomData.config.impostorCount || 1}</b></label>
                        <input
                            type="range"
                            min="1"
                            max={Math.max(1, Math.floor(players.length / 2))}
                            value={roomData.config.impostorCount || 1}
                            onChange={e => updateDoc(doc(db, "salas", roomCode), { "config.impostorCount": parseInt(e.target.value) })}
                            style={{ width: '100%' }}
                        />
                        <button onClick={iniciarPartida} style={{ marginTop: 20, background: '#28a745', fontSize: '1.2em' }}>COMENZAR</button>
                    </div>
                )}
            </div>
        );
    }

    // GAME PLAY
    // DEVICE MODE: Pass & Play Logic
    if (roomData.mode === 'DEVICE') {
        const player = players[currentTurnIndex];
        const amImpostor = roomData.impostores.includes(player.uid);
        const wordInfo = roomData.gameData;

        // VOTING PHASE (OFFLINE)
        if (roomData.estado === "VOTACION") {
            return (
                <div className="card">
                    <Header />
                    <h2>TIEMPO DE VOTACIÓN</h2>
                    <p>Discutan y decidan quién es el Impostor.</p>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 20 }}>
                        {players.map(p => (
                            <button
                                key={p.uid}
                                disabled={p.estado === 'muerto'}
                                onClick={() => {
                                    if (confirm(`¿Eliminar a ${p.nombre}?`)) {
                                        // Logic to kill
                                        // Just show result immediately?
                                        // Reuse 'procesarVotacion' logic logic basically
                                        // Manually trigger endpoint or update doc
                                        const isImp = roomData.impostores.includes(p.uid);
                                        const newP = players.map(pl => pl.uid === p.uid ? { ...pl, estado: 'muerto' } : pl);

                                        // Check win
                                        const vivos = newP.filter(pl => pl.estado === 'vivo');
                                        const impsVivos = vivos.filter(pl => roomData.impostores.includes(pl.uid));
                                        const tripVivos = vivos.filter(pl => !roomData.impostores.includes(pl.uid));

                                        let win = null;
                                        if (impsVivos.length === 0) win = 'TRIPULANTE';
                                        else if (impsVivos.length >= tripVivos.length) win = 'IMPOSTOR';

                                        updateDoc(doc(db, "salas", roomCode), {
                                            estado: win ? "VICTORIA" : "RESULTADO_RONDA",
                                            [roomData.mode === 'DEVICE' ? 'localPlayers' : 'jugadores']: newP,
                                            lastResult: {
                                                type: win ? 'WIN' : 'ELIMINATED',
                                                winner: win,
                                                victimName: p.nombre,
                                                victimRole: isImp ? 'IMPOSTOR' : 'INOCENTE'
                                            }
                                        });
                                    }
                                }}
                                style={{ background: p.estado === 'muerto' ? '#333' : '#444', textAlign: 'left', padding: 15 }}
                            >
                                {p.estado === 'muerto' ? '💀 ' : ''}{p.nombre}
                            </button>
                        ))}
                    </div>
                </div>
            );
        }

        // RESULT PHASE
        if (roomData.estado === "RESULTADO_RONDA" || roomData.estado === "VICTORIA") {
            const res = roomData.lastResult;
            return (
                <div className="card">
                    <Header />
                    <h1>{res.type === 'WIN' ? '¡JUEGO TERMINADO!' : 'Resultado'}</h1>
                    {res.winner && <h2>Ganan: {res.winner}</h2>}

                    <div style={{ background: '#333', padding: 20, borderRadius: 10, margin: '20px 0' }}>
                        <p>Eliminado:</p>
                        <h2>{res.victimName}</h2>
                        <h3>Era: <span style={{ color: res.victimRole === 'IMPOSTOR' ? 'red' : 'green' }}>{res.victimRole}</span></h3>
                    </div>

                    {isHost && (
                        <div style={{ display: 'flex', gap: 10 }}>
                            {res.winner ? (
                                <button onClick={() => updateDoc(doc(db, "salas", roomCode), { estado: "LOBBY" })} style={{ background: 'blue' }}>Lobby</button>
                            ) : (
                                <button onClick={() => updateDoc(doc(db, "salas", roomCode), { estado: "JUEGO" })}>Continuar</button>
                            )}
                        </div>
                    )}
                </div>
            )
        }

        // ROLE REVEAL LOOP
        return (
            <div className="pass-phone-screen">
                <Header />
                {player.estado === 'muerto' ? (
                    // Skip dead players?
                    // Logic handled by Host probably manually or next/prev buttons
                    // Simple: Only Alive players see roles?
                    // For MVP, just show everyone.
                    <p>Jugador eliminado.</p>
                ) : (
                    <>
                        {!showRole ? (
                            <div onClick={() => setShowRole(true)} style={{ cursor: 'pointer', textAlign: 'center' }}>
                                <h1 style={{ fontSize: '4em' }}>📱</h1>
                                <h2>Pásale el cel a:</h2>
                                <h1 style={{ color: '#03a9f4' }}>{player.nombre}</h1>
                                <p>(Toca para ver)</p>
                            </div>
                        ) : (
                            <div onMouseUp={() => setShowRole(false)} onTouchEnd={() => setShowRole(false)} style={{ textAlign: 'center' }}>
                                <h2>Tu Rol:</h2>
                                {amImpostor ? (
                                    <>
                                        <h1 style={{ color: 'red', fontSize: '3em' }}>IMPOSTOR</h1>
                                        <p>Pista: {roomData.config.pistasActivas ? wordInfo.pista : '???'}</p>
                                    </>
                                ) : (
                                    <>
                                        <h1 style={{ color: 'green', fontSize: '3em' }}>{wordInfo.palabra}</h1>
                                        <p>{wordInfo.categoria}</p>
                                    </>
                                )}
                                <div style={{ marginTop: 50 }}>
                                    <button onClick={() => {
                                        setShowRole(false);
                                        if (currentTurnIndex >= players.length - 1) {
                                            setCurrentTurnIndex(-1);
                                        } else {
                                            setCurrentTurnIndex(currentTurnIndex + 1);
                                        }
                                    }}>OK, Siguiente</button>
                                </div>
                            </div>
                        )}
                    </>
                )}

                <div style={{ position: 'fixed', bottom: 10 }}>
                    {/* Host Controls */}
                    <button onClick={() => updateDoc(doc(db, "salas", roomCode), { estado: "VOTACION" })} style={{ background: '#ff9800', width: 'auto', fontSize: '0.8em' }}>
                        Iniciar Votación
                    </button>
                </div>
            </div>
        );
    }

    // NEW: "Everyone has seen their role" view for Device Mode
    if (roomData.mode === 'DEVICE' && currentTurnIndex === -1) {
        return (
            <div className="card">
                <Header />
                <h2>¡Roles Repartidos!</h2>
                <p>La IA ha decidido que empieza preguntando:</p>
                <h1 style={{ color: '#ffeb3b', fontSize: '2.5em', margin: '20px 0', animation: 'shake 0.5s' }}>{roomData.gameData.startingPlayer}</h1>

                <div style={{ marginTop: 30 }}>
                    <button onClick={() => updateDoc(doc(db, "salas", roomCode), { estado: "VOTACION" })} style={{ background: '#ff9800', color: 'black' }}>IR A VOTACIÓN</button>
                </div>
            </div>
        );
    }

    // ONLINE MODE (Classic)

    // --- RENDERS FOR ONLINE MODE ---

    const isDead = roomData.jugadores.find(j => j.uid === localUser.uid)?.estado === 'muerto';
    const amImpostor = roomData.impostores.includes(localUser.uid);
    const me = roomData.jugadores.find(j => j.uid === localUser.uid);

    // GAME
    if (roomData.estado === "JUEGO") {
        return (
            <div className="card">
                <Header />
                {isDead && <div style={{ background: '#d32f2f', color: 'white', padding: '8px', borderRadius: '4px', marginBottom: '10px' }}>👻 ESTÁS ELIMINADO</div>}
                <h2>RONDA DE PREGUNTAS</h2>
                {roomData.gameData.startingPlayer && (
                    <div style={{ marginBottom: 10, color: '#ffeb3b', animation: 'fadeIn 1s' }}>
                        Empieza preguntando: <b>{roomData.gameData.startingPlayer}</b>
                    </div>
                )}

                <div
                    className="noselect"
                    onMouseDown={() => setRevealRole(true)}
                    onMouseUp={() => setRevealRole(false)}
                    onTouchStart={() => setRevealRole(true)}
                    onTouchEnd={() => setRevealRole(false)}
                    style={{
                        padding: '50px 20px',
                        background: revealRole ? (amImpostor ? '#3a1c1c' : '#1c3a1c') : '#444',
                        border: revealRole ? (amImpostor ? '3px solid #f44' : '3px solid #4f4') : '3px dashed #666',
                        borderRadius: '15px', margin: '20px 0', cursor: 'pointer',
                        userSelect: 'none'
                    }}
                >
                    {!revealRole ? (
                        <div>
                            <div style={{ fontSize: '3em' }}>🕵️</div>
                            <h3>MANTÉN PULSADO<br />PARA VER ROL</h3>
                        </div>
                    ) : (
                        <div style={{ animation: 'fadeIn 0.2s' }}>
                            {amImpostor ? (
                                <>
                                    <h1 style={{ color: '#f44', margin: 0 }}>IMPOSTOR</h1>
                                    <p style={{ marginTop: '10px' }}>{roomData.config.pistasActivas ? roomData.gameData.pista : '???'}</p>
                                </>
                            ) : (
                                <>
                                    <h3 style={{ margin: 0, color: '#aaa' }}>PALABRA:</h3>
                                    <h1 style={{ color: '#4f4', fontSize: '2.5em', margin: '5px 0' }}>{roomData.gameData.palabra}</h1>
                                    <p>{roomData.gameData.categoria}</p>
                                </>
                            )}
                        </div>
                    )}
                </div>

                {isHost && (
                    <button onClick={() => updateDoc(doc(db, "salas", roomCode), { estado: "VOTACION" })} style={{ background: '#ff9800', color: '#000' }}>IR A VOTACIÓN</button>
                )}
            </div>
        );
    }

    // VOTING
    if (roomData.estado === "VOTACION") {
        const votesReceived = {};
        roomData.jugadores.forEach(j => {
            if (j.voto) {
                if (!votesReceived[j.voto]) votesReceived[j.voto] = [];
                votesReceived[j.voto].push(j.nombre);
            }
        });

        const votar = async (targetUid) => {
            if (!me || me.estado === 'muerto') return;
            const newJugadores = roomData.jugadores.map(j => {
                if (j.uid === localUser.uid) return { ...j, voto: targetUid };
                return j;
            });
            await updateDoc(doc(db, "salas", roomCode), { jugadores: newJugadores });
        };

        const procesarVotacion = async () => {
            // 1. Tally
            const voteCounts = {};
            roomData.jugadores.forEach(j => {
                if (j.voto) voteCounts[j.voto] = (voteCounts[j.voto] || 0) + 1;
            });
            const sortedIds = Object.keys(voteCounts).sort((a, b) => voteCounts[b] - voteCounts[a]);

            if (sortedIds.length === 0 || (sortedIds.length > 1 && voteCounts[sortedIds[0]] === voteCounts[sortedIds[1]])) {
                // Tie or no votes
                await updateDoc(doc(db, "salas", roomCode), {
                    estado: "RESULTADO_RONDA",
                    lastResult: { type: 'TIE' },
                    jugadores: roomData.jugadores.map(j => ({ ...j, voto: null }))
                });
                return;
            }

            const topId = sortedIds[0];
            const victim = roomData.jugadores.find(j => j.uid === topId);
            const wasImpostor = roomData.impostores.includes(topId);

            // Update players (kill victim)
            const updatedJugadores = roomData.jugadores.map(j => {
                return j.uid === topId ? { ...j, estado: 'muerto', voto: null } : { ...j, voto: null };
            });

            // Check Win
            const vivos = updatedJugadores.filter(j => j.estado === 'vivo');
            const impsVivos = vivos.filter(j => roomData.impostores.includes(j.uid));
            const tripVivos = vivos.filter(j => !roomData.impostores.includes(j.uid));

            let win = null;
            if (impsVivos.length === 0) win = 'TRIPULANTE';
            else if (impsVivos.length >= tripVivos.length) win = 'IMPOSTOR';

            await updateDoc(doc(db, "salas", roomCode), {
                estado: win ? "VICTORIA" : "RESULTADO_RONDA",
                jugadores: updatedJugadores,
                lastResult: {
                    type: win ? 'WIN' : 'ELIMINATED',
                    winner: win,
                    victimName: victim.nombre,
                    victimUid: victim.uid,
                    victimRole: wasImpostor ? 'IMPOSTOR' : 'INOCENTE',
                    voters: roomData.jugadores.filter(j => j.voto === topId).map(j => j.nombre)
                }
            });
        };

        return (
            <div className="card">
                <Header />
                {isDead && <div style={{ background: '#555', padding: '5px' }}>👻 Los muertos no votan</div>}
                <h2>🗳️ VOTA A UN SOSPECHOSO</h2>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                    {roomData.jugadores.map(j => {
                        const isSelected = me?.voto === j.uid;
                        const voters = votesReceived[j.uid] || [];
                        return (
                            <button
                                key={j.uid}
                                onClick={() => votar(j.uid)}
                                disabled={isDead || j.estado === 'muerto'}
                                style={{
                                    background: isSelected ? '#ff9800' : (j.estado === 'muerto' ? '#222' : '#444'),
                                    opacity: j.estado === 'muerto' ? 0.5 : 1,
                                    height: 'auto', minHeight: '70px',
                                    border: isSelected ? '2px solid white' : '1px solid #555'
                                }}
                            >
                                {j.estado === 'muerto' ? '💀 ' : ''}{j.nombre}
                                {voters.length > 0 && (
                                    <div style={{ fontSize: '0.7em', color: '#aff', marginTop: '5px' }}>
                                        {voters.join(', ')}
                                    </div>
                                )}
                            </button>
                        );
                    })}
                </div>
                {isHost && <button onClick={procesarVotacion} style={{ background: '#d32f2f', marginTop: '20px' }}>CERRAR VOTACIÓN</button>}
            </div>
        );
    }

    // RESULT
    if (roomData.estado === "RESULTADO_RONDA" || roomData.estado === "VICTORIA") {
        const res = roomData.lastResult;
        const amIVictim = localUser.uid === res.victimUid;

        if (amIVictim && res.type !== 'TIE' && res.type !== 'WIN') { // Victim Overlay
            return (
                <div className="overlay-eliminated">
                    <h1 style={{ fontSize: '3em', color: '#f44' }}>¡ELIMINADO!</h1>
                    <div style={{ background: 'rgba(0,0,0,0.5)', padding: '20px', borderRadius: '10px', marginTop: '20px' }}>
                        <p>Votaron por ti:</p>
                        <h3 style={{ color: '#ffeb3b' }}>{res.voters && res.voters.join(', ')}</h3>
                    </div>
                    {isHost && <button onClick={() => updateDoc(doc(db, "salas", roomCode), { estado: "JUEGO" })} style={{ marginTop: 20, background: 'white', color: 'black' }}>Continuar</button>}
                </div>
            );
        }

        return (
            <div className="card">
                <Header />
                {roomData.estado === "VICTORIA" ? (
                    <div style={{ background: res.winner === 'IMPOSTOR' ? '#411' : '#141', padding: '20px', borderRadius: '10px', marginBottom: '20px' }}>
                        <h1>🏆 {res.winner === 'IMPOSTOR' ? 'Ganan Impostores' : 'Gana Tripulación'}</h1>
                    </div>
                ) : (
                    <h2>RESULTADO</h2>
                )}

                {res.type === 'TIE' ? (
                    <div style={{ padding: '20px', background: '#333' }}><h1>⚖️ EMPATE</h1></div>
                ) : (
                    <div style={{ padding: '20px', background: '#333', borderRadius: '10px' }}>
                        <p>Eliminado:</p>
                        <h1>{res.victimName}</h1>
                        <h2 style={{ color: res.victimRole === 'IMPOSTOR' ? '#f44' : '#4f4' }}>ERA {res.victimRole}</h2>
                    </div>
                )}

                {roomData.estado === "VICTORIA" ? (
                    <div style={{ marginTop: 20 }}>
                        <p>Palabra: <b style={{ color: '#4f4' }}>{roomData.gameData.palabra}</b></p>
                        <p>Impostores: {roomData.jugadores.filter(j => roomData.impostores.includes(j.uid)).map(j => j.nombre).join(', ')}</p>
                        {isHost && <button onClick={() => updateDoc(doc(db, "salas", roomCode), {
                            estado: "LOBBY",
                            jugadores: roomData.jugadores.map(j => ({ ...j, voto: null, estado: 'vivo' })),
                            impostores: [],
                            gameData: { palabra: "", categoria: "", pista: "" },
                            lastResult: null
                        })} style={{ marginTop: 20 }}>NUEVA PARTIDA (Lobby)</button>}
                    </div>
                ) : (
                    isHost && <button onClick={() => updateDoc(doc(db, "salas", roomCode), { estado: "JUEGO" })} style={{ background: '#2196f3', marginTop: 20 }}>CONTINUAR</button>
                )}
            </div>
        );
    }

    return <div>Cargando...</div>;
}

export default App;
