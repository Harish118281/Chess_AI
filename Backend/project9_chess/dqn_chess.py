import chess
import random
import numpy as np
import torch
import torch.nn as nn
import torch.optim as optim
from collections import deque

DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")

LR = 0.0005
GAMMA = 0.99
EPSILON_START = 1.0
EPSILON_MIN = 0.05
EPSILON_DECAY = 0.995
MEMORY_SIZE = 50000
BATCH_SIZE = 64


# =====================
# Board Encoding
# =====================

def encode_board(board):
    vec = np.zeros(768, dtype=np.float32)

    for square, piece in board.piece_map().items():
        idx = square
        value = piece.piece_type
        if not piece.color:
            value = -value
        vec[idx] = value

    return vec


# =====================
# DQN Model
# =====================

class DQN(nn.Module):
    def __init__(self):
        super().__init__()

        self.net = nn.Sequential(
            nn.Linear(768, 256),
            nn.ReLU(),
            nn.Linear(256, 128),
            nn.ReLU(),
            nn.Linear(128, 4672)
        )

    def forward(self, x):
        return self.net(x)


# =====================
# Agent
# =====================

class ChessAgent:
    def __init__(self):
        self.model = DQN().to(DEVICE)
        self.target_model = DQN().to(DEVICE)

        self.optimizer = optim.Adam(self.model.parameters(), lr=LR)
        self.memory = deque(maxlen=MEMORY_SIZE)

        self.epsilon = EPSILON_START
        self.update_target()

    def update_target(self):
        self.target_model.load_state_dict(self.model.state_dict())

    def remember(self, s, a, r, ns, done):
        self.memory.append((s, a, r, ns, done))

    def train_step(self):

        if len(self.memory) < BATCH_SIZE:
            return

        batch = random.sample(self.memory, BATCH_SIZE)

        states, actions, rewards, next_states, dones = zip(*batch)

        states = torch.tensor(np.array(states)).to(DEVICE)
        next_states = torch.tensor(np.array(next_states)).to(DEVICE)
        rewards = torch.tensor(rewards).to(DEVICE)
        actions = torch.tensor(actions).to(DEVICE)

        q_vals = self.model(states)
        next_q = self.target_model(next_states).detach()

        target = rewards + GAMMA * torch.max(next_q, dim=1)[0]

        predicted = q_vals.gather(1, actions.unsqueeze(1)).squeeze()

        loss = nn.MSELoss()(predicted, target)

        self.optimizer.zero_grad()
        loss.backward()
        self.optimizer.step()

        if self.epsilon > EPSILON_MIN:
            self.epsilon *= EPSILON_DECAY

    def select_action(self, board):
        legal_moves = list(board.legal_moves)

        if random.random() < self.epsilon:
            return random.choice(legal_moves)

        state = torch.tensor(encode_board(board)).to(DEVICE)

        with torch.no_grad():
            q_values = self.model(state)

        best_move = None
        best_score = -float("inf")

        for move in legal_moves:
            idx = move.from_square * 64 + move.to_square
            score = q_values[idx].item()
            if score > best_score:
                best_score = score
                best_move = move

        return best_move


# =====================
# Minimax Using Q-values
# =====================

def minimax(agent, board, depth, maximizing):

    if depth == 0 or board.is_game_over():
        state = torch.tensor(encode_board(board)).to(DEVICE)
        with torch.no_grad():
            q = agent.model(state)
        return torch.max(q).item()

    if maximizing:
        max_eval = -float("inf")
        for move in board.legal_moves:
            board.push(move)
            eval = minimax(agent, board, depth-1, False)
            board.pop()
            max_eval = max(max_eval, eval)
        return max_eval
    else:
        min_eval = float("inf")
        for move in board.legal_moves:
            board.push(move)
            eval = minimax(agent, board, depth-1, True)
            board.pop()
            min_eval = min(min_eval, eval)
        return min_eval


def play_self_game(agent):

    board = chess.Board()

    while not board.is_game_over():

        state = encode_board(board)
        move = agent.select_action(board)
        action_index = move.from_square * 64 + move.to_square

        board.push(move)

        reward = 0
        if board.is_game_over():
            result = board.result()
            if result == "1-0":
                reward = 1
            elif result == "0-1":
                reward = -1

        next_state = encode_board(board)
        done = board.is_game_over()

        agent.remember(state, action_index, reward, next_state, done)
        agent.train_step()

    agent.update_target()