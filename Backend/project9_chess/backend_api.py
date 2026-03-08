import chess
import torch
import threading
import os
import time
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dqn_chess import ChessAgent, encode_board, DEVICE, play_self_game, minimax


ADMIN_KEY = "H:a:r:i:s:h:m"
# ---------------------------
# Paths
# ---------------------------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH = os.path.join(BASE_DIR, "chess_model.pt")

# ---------------------------
# FastAPI Setup
# ---------------------------
app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------
# Global Variables
# ---------------------------
agent = ChessAgent()
model_lock = threading.Lock()
training_event = threading.Event()
training_running = False
trainer_thread = None
human_memory = []

# ---------------------------
# Load Model
# ---------------------------
if os.path.exists(MODEL_PATH):
    try:
        agent.model.load_state_dict(torch.load(MODEL_PATH, map_location=DEVICE))
        print("✅ Model Loaded from disk")
    except Exception as e:
        print("⚠ Model mismatch. Starting fresh.")
else:
    print("⚠ Starting fresh model")

# ---------------------------
# Request Model
# ---------------------------
class MoveRequest(BaseModel):
    fen: str

class ResetRequest(BaseModel):
    key: str

# ---------------------------
# AI Move (Minimax + DQL Eval)
# ---------------------------
def get_ai_move(board):
    with model_lock:
        best_move = None
        best_value = -float("inf")

        for move in board.legal_moves:
            board.push(move)
            value = minimax(agent, board, 2, False)
            board.pop()

            if value > best_value:
                best_value = value
                best_move = move

        return best_move

# ---------------------------
# Continuous Training Loop
# ---------------------------
def continuous_training():
    global training_running

    training_running = True
    print("🔥 AI TRAINING STARTED")

    while not training_event.is_set():

        # Add human experiences
        for exp in human_memory:
            agent.remember(*exp)

        # Train neural network
        for _ in range(20):
            with model_lock:
                agent.train_step()

        # Self-play training
        play_self_game(agent)

        time.sleep(0.1)

    with model_lock:
        torch.save(agent.model.state_dict(), MODEL_PATH)
        print("💾 Model Saved")

    training_running = False
    print("⛔ TRAINING STOPPED")

# ---------------------------
# API ROUTES
# ---------------------------

@app.post("/api/ai-move")
def ai_move(req: MoveRequest):
    board = chess.Board(req.fen)
    move = get_ai_move(board)
    return {"move": str(move)}

@app.post("/api/game-end")
def game_end(req: MoveRequest):
    global trainer_thread

    print("📩 GAME END RECEIVED")

    board = chess.Board(req.fen)
    result = board.result()

    reward = 0
    if result == "1-0":
        reward = 1
    elif result == "0-1":
        reward = -1
    else:
        reward = 0

    state = encode_board(board)

    # Store human game experience
    human_memory.append((state, 0, reward, state, True))

    # Start training
    training_event.clear()

    if not training_running:
        trainer_thread = threading.Thread(target=continuous_training)
        trainer_thread.start()

    return {"status": "training_started"}

@app.post("/api/play-button-clicked")
def stop_training():
    print("🛑 PLAY BUTTON CLICKED — Stopping training...")
    training_event.set()
    return {"status": "training_stopping"}

@app.get("/api/status")
def get_status():
    return {
        "training_running": training_running,
        "memory_size": len(agent.memory),
        "epsilon": agent.epsilon
    }

@app.post("/api/admin/reset-ai")
def reset_ai(req: ResetRequest):

    global agent, human_memory, training_running

    if req.key != ADMIN_KEY:
        return {"status": "error", "message": "Invalid admin key"}

    print("⚠ ADMIN RESET REQUESTED")

    # stop training
    training_event.set()
    training_running = False

    # clear memories
    agent.memory.clear()
    human_memory.clear()

    # reset model
    agent = ChessAgent()

    # delete saved model
    if os.path.exists(MODEL_PATH):
        os.remove(MODEL_PATH)
        print("🗑 Old model deleted")

    print("✅ AI MEMORY RESET COMPLETE")

    return {"status": "success", "message": "AI reset successfully"}

@app.get("/")
def root():
    return {"message": "Self Improving DQL + Minimax Chess AI Running"}