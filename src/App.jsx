import React, { useState, useEffect } from 'react';
import { db } from './firebase';
import {
    doc, setDoc, getDoc, onSnapshot, updateDoc, arrayUnion, arrayRemove, deleteDoc
} from 'firebase/firestore';
import { defaultWordBank } from './words';

function App() {
    // --- STATE ---
    const [user, setUser] = useState(null); // { uid, nombre }
    const [roomCode, setRoomCode] = useState('');
    const [roomData, setRoomData] = useState(null);

    // UI - Local
    const [viewMode, setViewMode] = useState('JOIN'); // 'JOIN' or 'CREATE'
    const [nombreInput, setNombreInput] = useState('');
    const [joinCodeInput, setJoinCodeInput] = useState('');

    // Host Config
    const [impostorCount, setImpostorCount] = useState(1);
    const [customCategory, setCustomCategory] = useState('');
    const [customWords, setCustomWords] = useState('');
    const [isAdvancedConfigOpen, setIsAdvancedConfigOpen] = useState(false);
    const [pistasActivas, setPistasActivas] = useState(true);

    const [revealRole, setRevealRole] = useState(false);

    // --- PERSISTENCE ---
    useEffect(() => {
        const savedSession = localStorage.getItem('impostor_session_v3');
        if (savedSession) {
            try {
                const { uid, nombre, roomCode: savedCode } = JSON.parse(savedSession);
                if (uid && nombre) {
                    setUser({ uid, nombre });
                    if (savedCode) {
                        setRoomCode(savedCode);
                        subscribeToRoom(savedCode, { uid, nombre });
                    }
                }
            } catch (e) {
                console.error("Session parse error", e);
            }
        }
    }, []);

    const saveSession = (u, code) => {
        localStorage.setItem('impostor_session_v3', JSON.stringify({
            uid: u.uid,
            nombre: u.nombre,
            roomCode: code || ''
        }));
    };

    const clearSession = () => {
        localStorage.removeItem('impostor_session_v3');
        setUser(null);
        setRoomCode('');
        setRoomData(null);
        setViewMode('JOIN');
    };

    // --- AUTH HELPER ---
    const login = (nombre) => {
        const uid = Math.random().toString(36).substring(7);
        const u = { uid, nombre };
        setUser(u);
        return u;
    };

    // --- ROOM MGMT ---
    const crearSala = async () => {
        try {
            if (!nombreInput.trim()) return alert("Ingresa tu nombre");

            console.log("Intentando crear sala...");
            const u = user || login(nombreInput);
            const code = Math.random().toString(36).substring(2, 6).toUpperCase();

            // Initial State
            await setDoc(doc(db, "salas", code), {
                host: u.uid,
                estado: "LOBBY",
                jugadores: [{ uid: u.uid, nombre: u.nombre, votos: 0, estado: 'vivo', voto: null }],
                impostores: [],
                config: { pistasActivas: true },
                gameData: { palabra: "", categoria: "", pista: "" },
                lastResult: null
            });

            setRoomCode(code);
            saveSession(u, code);
            subscribeToRoom(code, u);
        } catch (error) {
            console.error("Error al crear sala:", error);
            alert("Error creando sala: " + error.message + "\n\n(Tip: Si es error de permisos/conexión, verifica tu internet o las reglas de Firebase. Si dice 'Missing or insufficient permissions', revisa las reglas. Si dice 'API key not valid', reinicia el servidor.)");
        }
    };

    const unirseSala = async () => {
        try {
            if ((!nombreInput && !user) || !joinCodeInput) return alert("Faltan datos");
            const code = joinCodeInput.toUpperCase();
            const roomRef = doc(db, "salas", code);
            const docSnap = await getDoc(roomRef);

            if (!docSnap.exists()) return alert("Sala no existe");

            const u = user || login(nombreInput);

            const currentPlayers = docSnap.data().jugadores || [];
            const exists = currentPlayers.some(p => p.uid === u.uid);

            if (!exists) {
                await updateDoc(roomRef, {
                    jugadores: arrayUnion({ uid: u.uid, nombre: u.nombre, votos: 0, estado: 'vivo', voto: null })
                });
            }

            setRoomCode(code);
            saveSession(u, code);
            subscribeToRoom(code, u);
        } catch (error) {
            console.error("Error al unirse:", error);
            alert("Error al unirse: " + error.message);
        }
    };

    const subscribeToRoom = (code, currentUser) => {
        onSnapshot(doc(db, "salas", code), (snapshot) => {
            if (!snapshot.exists()) {
                if (currentUser) {
                    clearSession();
                    alert("La sala ha sido cerrada.");
                } else {
                    setRoomData(null);
                }
            } else {
                setRoomData(snapshot.data());
            }
        });
    };

    const abandonarSala = async () => {
        if (!user || !roomCode || !roomData) return;
        const me = roomData.jugadores.find(j => j.uid === user.uid);
        if (me) {
            await updateDoc(doc(db, "salas", roomCode), {
                jugadores: arrayRemove(me)
            });
        }
        clearSession();
    };

    const cerrarSala = async () => {
        if (!roomCode) return;
        if (confirm("¿Cerrar sala para todos?")) {
            await deleteDoc(doc(db, "salas", roomCode));
            clearSession();
        }
    };

    // --- GAME LOGIC ---

    const iniciarPartida = async () => {
        if (impostorCount >= roomData.jugadores.length / 2) {
            return alert("Demasiados impostores. Reduce cantidad.");
        }

        // Pick Word
        let categoria = "";
        let palabra = "";
        let pista = "";

        if (customWords.trim()) {
            categoria = customCategory || "Personalizada";
            const wList = customWords.split(/[\n,]+/).map(s => s.trim()).filter(s => s);
            const selected = wList[Math.floor(Math.random() * wList.length)];
            palabra = selected;
            pista = "Personalizada";
        } else {
            const cats = Object.keys(defaultWordBank);
            categoria = cats[Math.floor(Math.random() * cats.length)];
            const items = defaultWordBank[categoria];
            const item = items[Math.floor(Math.random() * items.length)];
            palabra = item.word;
            pista = item.hint;
        }

        // Role Assignment
        const pIds = roomData.jugadores.map(p => p.uid);
        const imps = [];
        while (imps.length < impostorCount) {
            const r = pIds[Math.floor(Math.random() * pIds.length)];
            if (!imps.includes(r)) imps.push(r);
        }

        // Reset Players
        const newJugadores = roomData.jugadores.map(j => ({
            ...j, votos: 0, estado: 'vivo', voto: null
        }));

        await updateDoc(doc(db, "salas", roomCode), {
            estado: "JUEGO",
            impostores: imps,
            config: { pistasActivas },
            gameData: { palabra, categoria, pista },
            jugadores: newJugadores,
            lastResult: null
        });
    };

    const irAVotar = async () => {
        await updateDoc(doc(db, "salas", roomCode), { estado: "VOTACION" });
    };

    // VOTE LOGIC: Now we record WHO voted for whom
    const votar = async (targetUid) => {
        const me = roomData.jugadores.find(j => j.uid === user.uid);
        if (!me || me.estado === 'muerto') return;

        // Toggle vote? Or change vote? Let's just set vote.
        const newJugadores = roomData.jugadores.map(j => {
            if (j.uid === user.uid) {
                // If clicking same person, unvote? Optional. Let's just set.
                return { ...j, voto: targetUid };
            }
            return j;
        });

        await updateDoc(doc(db, "salas", roomCode), { jugadores: newJugadores });
    };

    const procesarVotacion = async () => {
        // 1. Tally votes based on 'voto' field
        const voteCounts = {}; // uid -> count
        roomData.jugadores.forEach(j => {
            if (j.voto) {
                voteCounts[j.voto] = (voteCounts[j.voto] || 0) + 1;
            }
        });

        // Sort by count
        const sortedIds = Object.keys(voteCounts).sort((a, b) => voteCounts[b] - voteCounts[a]);

        if (sortedIds.length === 0) {
            // No votes?
            await updateDoc(doc(db, "salas", roomCode), {
                estado: "RESULTADO_RONDA",
                lastResult: { type: 'TIE' },
                jugadores: roomData.jugadores.map(j => ({ ...j, voto: null }))
            });
            return;
        }

        const topId = sortedIds[0];
        const maxVotes = voteCounts[topId];

        // Check Tie
        const tied = sortedIds.filter(id => voteCounts[id] === maxVotes);
        if (tied.length > 1) {
            await updateDoc(doc(db, "salas", roomCode), {
                estado: "RESULTADO_RONDA",
                lastResult: { type: 'TIE' }, // Show info about tie?
                jugadores: roomData.jugadores.map(j => ({ ...j, voto: null }))
            });
            return;
        }

        // Elimination
        const victim = roomData.jugadores.find(j => j.uid === topId);
        const wasImpostor = roomData.impostores.includes(topId);

        // Mark victim as dead
        const updatedJugadores = roomData.jugadores.map(j => {
            if (j.uid === topId) return { ...j, estado: 'muerto', voto: null };
            return { ...j, voto: null };
        });

        // COLLECT VOTERS FOR VICTIM (For animation)
        const votersForVictim = roomData.jugadores
            .filter(j => j.voto === topId)
            .map(j => j.nombre);

        // CHECK WIN
        const vivos = updatedJugadores.filter(j => j.estado === 'vivo');
        const impsVivos = vivos.filter(j => roomData.impostores.includes(j.uid));
        const tripVivos = vivos.filter(j => !roomData.impostores.includes(j.uid));

        let winState = null;
        if (impsVivos.length === 0) winState = 'TRIPULANTE';
        else if (impsVivos.length >= tripVivos.length) winState = 'IMPOSTOR';

        const resultPayload = {
            type: winState ? 'WIN' : 'ELIMINATED',
            winner: winState,
            victimName: victim.nombre,
            victimUid: victim.uid, // To show specific screen
            victimRole: wasImpostor ? 'IMPOSTOR' : 'INOCENTE',
            voters: votersForVictim
        };

        await updateDoc(doc(db, "salas", roomCode), {
            estado: winState ? "VICTORIA" : "RESULTADO_RONDA",
            jugadores: updatedJugadores,
            lastResult: resultPayload
        });
    };

    const continuarRonda = async () => {
        await updateDoc(doc(db, "salas", roomCode), { estado: "JUEGO" });
    };

    const nuevaPartida = async () => {
        await updateDoc(doc(db, "salas", roomCode), {
            estado: "LOBBY",
            jugadores: roomData.jugadores.map(j => ({ ...j, voto: null, estado: 'vivo' })),
            impostores: [],
            gameData: { palabra: "", categoria: "", pista: "" },
            lastResult: null
        });
    };

    // --- RENDERS ---

    if (!user || (!roomData && !roomCode)) {
        // HOME SCREEN REDESIGN
        return (
            <div className="card">
                <h1 style={{ fontSize: '2.5em', marginBottom: '30px' }}>🕵️ EL IMPOSTOR</h1>

                {viewMode === 'JOIN' && (
                    <div style={{ animation: 'fadeIn 0.3s' }}>
                        <input
                            placeholder="Tu Nombre"
                            value={nombreInput}
                            onChange={e => setNombreInput(e.target.value)}
                            style={{ marginBottom: '10px' }}
                        />
                        <input
                            placeholder="Código de Sala (Ej: ABCD)"
                            value={joinCodeInput}
                            onChange={e => setJoinCodeInput(e.target.value)}
                            style={{ marginBottom: '20px' }}
                        />
                        <button
                            onClick={unirseSala}
                            style={{ padding: '15px', fontSize: '1.2em', fontWeight: 'bold' }}
                        >
                            UNIRSE A SALA
                        </button>

                        <div style={{ marginTop: '30px', borderTop: '1px solid #555', paddingTop: '20px' }}>
                            <p style={{ color: '#aaa', marginBottom: '10px' }}>¿No tienes código?</p>
                            <button
                                onClick={() => setViewMode('CREATE')}
                                style={{ background: 'transparent', border: '1px solid #666', fontSize: '0.9em', color: '#ccc' }}
                            >
                                Crear Nueva Sala
                            </button>
                        </div>
                    </div>
                )}

                {viewMode === 'CREATE' && (
                    <div style={{ animation: 'fadeIn 0.3s' }}>
                        <h3 style={{ marginBottom: '20px' }}>Nueva Sala</h3>
                        <input
                            placeholder="Tu Nombre de Host"
                            value={nombreInput}
                            onChange={e => setNombreInput(e.target.value)}
                        />
                        <button
                            onClick={crearSala}
                            style={{ marginTop: '20px', background: '#28a745' }}
                        >
                            CREAR SALA
                        </button>
                        <button
                            onClick={() => setViewMode('JOIN')}
                            style={{ marginTop: '10px', background: 'transparent', color: '#aaa' }}
                        >
                            Cancelar
                        </button>
                    </div>
                )}
            </div>
        );
    }

    if (!roomData) return <div>Cargando Sala...</div>;

    const isHost = roomData.host === user.uid;
    const me = roomData.jugadores.find(j => j.uid === user.uid);
    const isDead = me?.estado === 'muerto';
    const isImpostor = roomData.impostores.includes(user.uid);

    const Header = () => (
        <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid #444', paddingBottom: '10px', marginBottom: '15px' }}>
            <b>Sala: {roomCode}</b>
            <button onClick={isHost ? cerrarSala : abandonarSala} style={{ background: '#d32f2f', padding: '5px 10px', fontSize: '0.8em', width: 'auto', margin: 0 }}>
                {isHost ? 'Cerrar' : 'Salir'}
            </button>
        </div>
    );

    // LOBBY
    if (roomData.estado === "LOBBY") {
        return (
            <div className="card">
                <Header />
                <h3>Jugadores en Sala ({roomData.jugadores.length})</h3>
                <ul style={{ textAlign: 'left', background: '#222', padding: '10px', borderRadius: '8px' }}>
                    {roomData.jugadores.map(j => <li key={j.uid} style={{ padding: '5px' }}>{j.nombre}</li>)}
                </ul>
                {isHost ? (
                    <div style={{ marginTop: '20px' }}>
                        <label style={{ display: 'block', marginBottom: '10px' }}>
                            <input type="checkbox" checked={pistasActivas} onChange={e => setPistasActivas(e.target.checked)} />
                            Ver Pista (Tripulantes ven palabra)
                        </label>
                        <label>Cantidad Impostores: <b>{impostorCount}</b></label>
                        <input type="range" min="1" max="3" value={impostorCount} onChange={e => setImpostorCount(parseInt(e.target.value))} style={{ width: '100%' }} />
                        <button onClick={iniciarPartida} style={{ background: '#28a745', marginTop: '20px' }}>EMPEZAR PARTIDA</button>
                    </div>
                ) : (
                    <p style={{ fontStyle: 'italic', color: '#888' }}>El anfitrión configurará la partida...</p>
                )}
            </div>
        );
    }

    // GAME
    if (roomData.estado === "JUEGO") {
        return (
            <div className="card">
                <Header />
                {isDead && <div style={{ background: '#d32f2f', color: 'white', padding: '8px', borderRadius: '4px', marginBottom: '10px' }}>👻 ESTÁS ELIMINADO</div>}
                <h2>RONDA DE PREGUNTAS</h2>

                <div
                    className="noselect"
                    onMouseDown={() => setRevealRole(true)}
                    onMouseUp={() => setRevealRole(false)}
                    onTouchStart={() => setRevealRole(true)}
                    onTouchEnd={() => setRevealRole(false)}
                    style={{
                        padding: '50px 20px',
                        background: revealRole ? (isImpostor ? '#3a1c1c' : '#1c3a1c') : '#444',
                        border: revealRole ? (isImpostor ? '3px solid #f44' : '3px solid #4f4') : '3px dashed #666',
                        borderRadius: '15px', margin: '20px 0', cursor: 'pointer'
                    }}
                >
                    {!revealRole ? (
                        <div>
                            <div style={{ fontSize: '3em' }}>🕵️</div>
                            <h3>MANTÉN PULSADO<br />PARA VER ROL</h3>
                        </div>
                    ) : (
                        <div style={{ animation: 'fadeIn 0.2s' }}>
                            {isImpostor ? (
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
                    <button onClick={irAVotar} style={{ background: '#ff9800', color: '#000' }}>IR A VOTACIÓN</button>
                )}
            </div>
        );
    }

    // VOTING
    if (roomData.estado === "VOTACION") {
        // Calculate active votes for display opacity/count?
        // Actually per requests users want to see "who votes for whom".
        // We can iterate players and count how many voted for EACH.
        const votesReceived = {}; // uid -> array of voter names
        roomData.jugadores.forEach(j => {
            if (j.voto) {
                if (!votesReceived[j.voto]) votesReceived[j.voto] = [];
                votesReceived[j.voto].push(j.nombre);
            }
        });

        return (
            <div className="card">
                <Header />
                {isDead && <div style={{ background: '#555', padding: '5px' }}>👻 Los muertos no votan</div>}
                <h2>🗳️ VOTA A UN SOSPECHOSO</h2>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                    {roomData.jugadores.map(j => {
                        // Am I voting for this person?
                        const isSelected = me?.voto === j.uid;
                        // Who voted for this person? (Visible to all)
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

                                {/* VISIBLE VOTES */}
                                {voters.length > 0 && (
                                    <div style={{ fontSize: '0.7em', color: '#aff', marginTop: '5px', wordBreak: 'break-word' }}>
                                        Votos: {voters.join(', ')}
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

    // RESULT (ELIMINATION / WIN)
    if (roomData.estado === "RESULTADO_RONDA" || roomData.estado === "VICTORIA") {
        const res = roomData.lastResult;
        const amIVictim = user.uid === res.victimUid;

        // ELIMINATION OVERLAY for Victim
        if (amIVictim && (roomData.estado === "RESULTADO_RONDA" || roomData.estado === "VICTORIA") && res.type !== 'TIE') {
            return (
                <div className="overlay-eliminated">
                    <h1 style={{ fontSize: '3em', color: '#f44' }}>¡ELIMINADO!</h1>
                    <h2 style={{ color: 'white' }}>La tribu ha hablado.</h2>
                    <div style={{ background: 'rgba(0,0,0,0.5)', padding: '20px', borderRadius: '10px', marginTop: '20px' }}>
                        <p>Votaron por ti:</p>
                        <h3 style={{ color: '#ffeb3b' }}>{res.voters && res.voters.join(', ')}</h3>
                    </div>
                    <p style={{ marginTop: '30px', fontSize: '0.8em' }}>Espera a que el host continúe...</p>

                    {isHost && (
                        <button onClick={continuarRonda} style={{ marginTop: '20px', background: 'white', color: 'black', width: 'auto' }}>
                            Continuar (Host)
                        </button>
                    )}
                </div>
            );
        }

        return (
            <div className="card">
                <Header />

                {roomData.estado === "VICTORIA" ? (
                    <div style={{ background: res.winner === 'IMPOSTOR' ? '#411' : '#141', padding: '20px', borderRadius: '10px', marginBottom: '20px' }}>
                        <h1>🏆 VICTORIA</h1>
                        <h2 style={{ color: res.winner === 'IMPOSTOR' ? '#f44' : '#4f4' }}>
                            {res.winner === 'IMPOSTOR' ? 'Ganan los Impostores' : 'Gana la Tripulación'}
                        </h2>
                    </div>
                ) : (
                    <h2>RESULTADO DE VOTACIÓN</h2>
                )}

                {res.type === 'TIE' ? (
                    <div style={{ padding: '20px', background: '#333' }}>
                        <h1>⚖️ EMPATE</h1>
                        <p>Nadie muere hoy.</p>
                    </div>
                ) : (
                    <div style={{ padding: '20px', background: '#333', borderRadius: '10px' }}>
                        <p>El eliminado fue:</p>
                        <h1>{res.victimName}</h1>
                        <div style={{ margin: '10px 0', fontSize: '0.9em', color: '#aaa' }}>
                            Traicionado por: <span style={{ color: '#fff' }}>{res.voters && res.voters.join(', ')}</span>
                        </div>
                        <h2 style={{
                            color: res.victimRole === 'IMPOSTOR' ? '#f44' : '#4f4',
                            border: `2px solid ${res.victimRole === 'IMPOSTOR' ? '#f44' : '#4f4'}`,
                            display: 'inline-block', padding: '5px 15px', borderRadius: '5px'
                        }}>
                            ERA {res.victimRole}
                        </h2>
                    </div>
                )}

                {roomData.estado === "VICTORIA" ? (
                    <div style={{ marginTop: '20px', textAlign: 'left', padding: '10px', background: '#222' }}>
                        <p>Palabra: <b style={{ color: '#4f4' }}>{roomData.gameData.palabra}</b></p>
                        <p>Impostores:</p>
                        <ul>
                            {roomData.jugadores
                                .filter(j => roomData.impostores.includes(j.uid))
                                .map(j => <li key={j.uid} style={{ color: '#f44' }}>{j.nombre}</li>)
                            }
                        </ul>
                        {isHost && <button onClick={nuevaPartida} style={{ marginTop: '20px' }}>NUEVA PARTIDA</button>}
                    </div>
                ) : (
                    <div>
                        {isHost ? (
                            <button onClick={continuarRonda} style={{ background: '#2196f3', marginTop: '20px' }}>CONTINUAR JUEGO</button>
                        ) : (
                            <p style={{ marginTop: '20px', color: '#888' }}>Esperando al host...</p>
                        )}
                    </div>
                )}
            </div>
        );
    }

    return <div>Cargando...</div>;
}

export default App;
