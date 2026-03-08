
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import './App.css';
import { BASE_URL, getAIMove, getStatus, notifyGameEnd, resetAiMemory, stopTraining } from './api';

type Color = 'w' | 'b';
type PieceType = 'p' | 'n' | 'b' | 'r' | 'q' | 'k';
type PromotionType = 'q' | 'r' | 'b' | 'n';
type GameResult = 'playing' | 'checkmate' | 'stalemate' | 'timeout';
type ScreenMode = 'home' | 'game' | 'ai-memory';
type PieceTheme = 'uscf' | 'alpha' | 'wikipedia';
type Board = Array<Array<Piece | null>>;

interface Piece {
  color: Color;
  type: PieceType;
}

interface Coord {
  row: number;
  col: number;
}

interface Move {
  from: Coord;
  to: Coord;
  promotion?: PromotionType;
  isEnPassant?: boolean;
}

interface PendingAnimation {
  from: Coord;
  to: Coord;
  piece: Piece;
}

interface PendingPromotion {
  from: Coord;
  to: Coord;
  options: Move[];
}

interface CastlingRights {
  wK: boolean;
  wQ: boolean;
  bK: boolean;
  bQ: boolean;
}

interface GameState {
  board: Board;
  turn: Color;
  castling: CastlingRights;
  enPassant: string | null;
  halfmove: number;
  fullmove: number;
  history: string[];
  lastMove: { from: string; to: string } | null;
  result: GameResult;
  winner: Color | null;
}

interface UiTheme {
  lightSquare: string;
  darkSquare: string;
  pieceTheme: PieceTheme;
}

const FILES = 'abcdefgh';
const PROMOTIONS: PromotionType[] = ['q', 'r', 'b', 'n'];
const LOCAL_STATE_KEY = 'chess_ai_frontend_state_v1';
const LOCAL_UI_THEME_KEY = 'chess_ai_frontend_ui_theme_v1';
const MOVE_ANIMATION_MS = 220;
const START_DELAY_SECONDS = 4;
const DEFAULT_TIME_CONTROL_MS = 10 * 60 * 1000;
const CLOCK_TICK_MS = 200;
const DEFAULT_UI_THEME: UiTheme = {
  lightSquare: '#f0d9b5',
  darkSquare: '#b58863',
  pieceTheme: 'uscf',
};
const TIME_CONTROL_OPTIONS: Array<{ label: string; ms: number }> = [
  { label: '3 Min', ms: 3 * 60 * 1000 },
  { label: '5 Min', ms: 5 * 60 * 1000 },
  { label: '10 Min', ms: 10 * 60 * 1000 },
  { label: '15 Min', ms: 15 * 60 * 1000 },
];

const PIECE_IMAGE_THEME_BASES: Record<PieceTheme, string> = {
  uscf: 'https://chessboardjs.com/img/chesspieces/uscf',
  alpha: 'https://chessboardjs.com/img/chesspieces/alpha',
  wikipedia: 'https://chessboardjs.com/img/chesspieces/wikipedia',
};

function createInitialBoard(): Board {
  const board: Board = Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => null));
  const backRank: PieceType[] = ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'];

  for (let col = 0; col < 8; col += 1) {
    board[0][col] = { color: 'b', type: backRank[col] };
    board[1][col] = { color: 'b', type: 'p' };
    board[6][col] = { color: 'w', type: 'p' };
    board[7][col] = { color: 'w', type: backRank[col] };
  }

  return board;
}

function createInitialGame(): GameState {
  return {
    board: createInitialBoard(),
    turn: 'w',
    castling: { wK: true, wQ: true, bK: true, bQ: true },
    enPassant: null,
    halfmove: 0,
    fullmove: 1,
    history: [],
    lastMove: null,
    result: 'playing',
    winner: null,
  };
}

interface PersistedAppState {
  game: GameState;
  humanColor: Color;
  whiteClockMs: number;
  blackClockMs: number;
  timeControlMs: number;
  screen: 'home' | 'game';
}

function loadPersistedAppState(): PersistedAppState | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(LOCAL_STATE_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<PersistedAppState>;
    if (!parsed || !parsed.game) {
      return null;
    }

    const game = parsed.game as GameState;
    if (
      !Array.isArray(game.board) ||
      game.board.length !== 8 ||
      !Array.isArray(game.history) ||
      (game.turn !== 'w' && game.turn !== 'b')
    ) {
      return null;
    }

    const humanColor: Color = parsed.humanColor === 'b' ? 'b' : 'w';
    const timeControlMs =
      typeof parsed.timeControlMs === 'number' && parsed.timeControlMs > 0
        ? parsed.timeControlMs
        : DEFAULT_TIME_CONTROL_MS;
    const whiteClockMs =
      typeof parsed.whiteClockMs === 'number' && parsed.whiteClockMs >= 0
        ? parsed.whiteClockMs
        : timeControlMs;
    const blackClockMs =
      typeof parsed.blackClockMs === 'number' && parsed.blackClockMs >= 0
        ? parsed.blackClockMs
        : timeControlMs;

    const hasProgress =
      game.history.length > 0 ||
      game.lastMove !== null ||
      game.result !== 'playing' ||
      whiteClockMs !== timeControlMs ||
      blackClockMs !== timeControlMs;
    const screen =
      parsed.screen === 'game' || parsed.screen === 'home'
        ? parsed.screen
        : hasProgress
          ? 'game'
          : 'home';

    return { game, humanColor, whiteClockMs, blackClockMs, timeControlMs, screen };
  } catch {
    return null;
  }
}

function savePersistedAppState(state: PersistedAppState): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(LOCAL_STATE_KEY, JSON.stringify(state));
  } catch {
    // Ignore storage write failures.
  }
}

function loadUiTheme(): UiTheme {
  if (typeof window === 'undefined') {
    return DEFAULT_UI_THEME;
  }

  try {
    const raw = window.localStorage.getItem(LOCAL_UI_THEME_KEY);
    if (!raw) {
      return DEFAULT_UI_THEME;
    }
    const parsed = JSON.parse(raw) as Partial<UiTheme>;

    return {
      lightSquare:
        typeof parsed.lightSquare === 'string' ? parsed.lightSquare : DEFAULT_UI_THEME.lightSquare,
      darkSquare:
        typeof parsed.darkSquare === 'string' ? parsed.darkSquare : DEFAULT_UI_THEME.darkSquare,
      pieceTheme:
        parsed.pieceTheme === 'uscf' ||
        parsed.pieceTheme === 'alpha' ||
        parsed.pieceTheme === 'wikipedia'
          ? parsed.pieceTheme
          : DEFAULT_UI_THEME.pieceTheme,
    };
  } catch {
    return DEFAULT_UI_THEME;
  }
}

function saveUiTheme(theme: UiTheme): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(LOCAL_UI_THEME_KEY, JSON.stringify(theme));
  } catch {
    // Ignore storage write failures.
  }
}

function pieceImageCode(piece: Piece): string {
  return `${piece.color}${piece.type.toUpperCase()}`;
}

function pieceImageUrl(pieceTheme: PieceTheme, piece: Piece): string {
  return `${PIECE_IMAGE_THEME_BASES[pieceTheme]}/${pieceImageCode(piece)}.png`;
}

function promotionTypeLabel(type: PromotionType): string {
  if (type === 'q') {
    return 'Queen';
  }
  if (type === 'r') {
    return 'Rook';
  }
  if (type === 'b') {
    return 'Bishop';
  }
  return 'Knight';
}

function formatClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function cloneBoard(board: Board): Board {
  return board.map((row) => row.map((cell) => (cell ? { ...cell } : null)));
}

function opponent(color: Color): Color {
  return color === 'w' ? 'b' : 'w';
}

function insideBoard(row: number, col: number): boolean {
  return row >= 0 && row < 8 && col >= 0 && col < 8;
}

function coordsEqual(a: Coord, b: Coord): boolean {
  return a.row === b.row && a.col === b.col;
}

function coordToSquare(coord: Coord): string {
  return `${FILES[coord.col]}${8 - coord.row}`;
}

function squareToCoord(square: string): Coord | null {
  const sanitized = square.trim().toLowerCase();
  if (!/^[a-h][1-8]$/.test(sanitized)) {
    return null;
  }

  const col = FILES.indexOf(sanitized[0]);
  const row = 8 - Number(sanitized[1]);
  return { row, col };
}

function moveToUci(move: Move): string {
  const base = `${coordToSquare(move.from)}${coordToSquare(move.to)}`;
  return move.promotion ? `${base}${move.promotion}` : base;
}

function parseUci(raw: string): { from: string; to: string; promotion?: PromotionType } | null {
  const text = raw.trim().toLowerCase();
  const match = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/.exec(text);
  if (!match) {
    return null;
  }

  return {
    from: match[1],
    to: match[2],
    promotion: (match[3] as PromotionType | undefined) ?? undefined,
  };
}

function findKing(board: Board, color: Color): Coord | null {
  for (let row = 0; row < 8; row += 1) {
    for (let col = 0; col < 8; col += 1) {
      const piece = board[row][col];
      if (piece && piece.color === color && piece.type === 'k') {
        return { row, col };
      }
    }
  }
  return null;
}

function isSquareAttacked(board: Board, target: Coord, byColor: Color): boolean {
  const knightOffsets = [
    [-2, -1],
    [-2, 1],
    [-1, -2],
    [-1, 2],
    [1, -2],
    [1, 2],
    [2, -1],
    [2, 1],
  ];
  const bishopDirs = [
    [-1, -1],
    [-1, 1],
    [1, -1],
    [1, 1],
  ];
  const rookDirs = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ];

  for (let row = 0; row < 8; row += 1) {
    for (let col = 0; col < 8; col += 1) {
      const piece = board[row][col];
      if (!piece || piece.color !== byColor) {
        continue;
      }

      if (piece.type === 'p') {
        const dir = byColor === 'w' ? -1 : 1;
        if (row + dir === target.row && (col - 1 === target.col || col + 1 === target.col)) {
          return true;
        }
      }

      if (piece.type === 'n') {
        for (const [dr, dc] of knightOffsets) {
          if (row + dr === target.row && col + dc === target.col) {
            return true;
          }
        }
      }

      if (piece.type === 'b' || piece.type === 'q') {
        for (const [dr, dc] of bishopDirs) {
          let r = row + dr;
          let c = col + dc;
          while (insideBoard(r, c)) {
            if (r === target.row && c === target.col) {
              return true;
            }
            if (board[r][c]) {
              break;
            }
            r += dr;
            c += dc;
          }
        }
      }

      if (piece.type === 'r' || piece.type === 'q') {
        for (const [dr, dc] of rookDirs) {
          let r = row + dr;
          let c = col + dc;
          while (insideBoard(r, c)) {
            if (r === target.row && c === target.col) {
              return true;
            }
            if (board[r][c]) {
              break;
            }
            r += dr;
            c += dc;
          }
        }
      }

      if (piece.type === 'k') {
        const rowGap = Math.abs(row - target.row);
        const colGap = Math.abs(col - target.col);
        if (rowGap <= 1 && colGap <= 1) {
          return true;
        }
      }
    }
  }

  return false;
}

function isInCheck(state: Pick<GameState, 'board'>, color: Color): boolean {
  const kingSquare = findKing(state.board, color);
  if (!kingSquare) {
    return false;
  }
  return isSquareAttacked(state.board, kingSquare, opponent(color));
}

function canCastle(state: GameState, color: Color, side: 'K' | 'Q'): boolean {
  const row = color === 'w' ? 7 : 0;
  const king = state.board[row][4];
  if (!king || king.type !== 'k' || king.color !== color) {
    return false;
  }

  const hasRight =
    color === 'w'
      ? side === 'K'
        ? state.castling.wK
        : state.castling.wQ
      : side === 'K'
        ? state.castling.bK
        : state.castling.bQ;
  if (!hasRight) {
    return false;
  }

  const enemy = opponent(color);

  if (side === 'K') {
    const rook = state.board[row][7];
    if (!rook || rook.type !== 'r' || rook.color !== color) {
      return false;
    }
    if (state.board[row][5] || state.board[row][6]) {
      return false;
    }
    if (
      isSquareAttacked(state.board, { row, col: 4 }, enemy) ||
      isSquareAttacked(state.board, { row, col: 5 }, enemy) ||
      isSquareAttacked(state.board, { row, col: 6 }, enemy)
    ) {
      return false;
    }
    return true;
  }

  const rook = state.board[row][0];
  if (!rook || rook.type !== 'r' || rook.color !== color) {
    return false;
  }
  if (state.board[row][1] || state.board[row][2] || state.board[row][3]) {
    return false;
  }
  if (
    isSquareAttacked(state.board, { row, col: 4 }, enemy) ||
    isSquareAttacked(state.board, { row, col: 3 }, enemy) ||
    isSquareAttacked(state.board, { row, col: 2 }, enemy)
  ) {
    return false;
  }
  return true;
}
function generatePseudoMoves(state: GameState, color: Color): Move[] {
  const moves: Move[] = [];
  const knightOffsets = [
    [-2, -1],
    [-2, 1],
    [-1, -2],
    [-1, 2],
    [1, -2],
    [1, 2],
    [2, -1],
    [2, 1],
  ];
  const bishopDirs = [
    [-1, -1],
    [-1, 1],
    [1, -1],
    [1, 1],
  ];
  const rookDirs = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ];

  const enPassantTarget = state.enPassant ? squareToCoord(state.enPassant) : null;

  for (let row = 0; row < 8; row += 1) {
    for (let col = 0; col < 8; col += 1) {
      const piece = state.board[row][col];
      if (!piece || piece.color !== color) {
        continue;
      }

      if (piece.type === 'p') {
        const dir = color === 'w' ? -1 : 1;
        const startRow = color === 'w' ? 6 : 1;
        const promotionRow = color === 'w' ? 0 : 7;
        const oneStepRow = row + dir;

        if (insideBoard(oneStepRow, col) && !state.board[oneStepRow][col]) {
          if (oneStepRow === promotionRow) {
            for (const promotion of PROMOTIONS) {
              moves.push({ from: { row, col }, to: { row: oneStepRow, col }, promotion });
            }
          } else {
            moves.push({ from: { row, col }, to: { row: oneStepRow, col } });
          }

          const twoStepRow = row + 2 * dir;
          if (row === startRow && insideBoard(twoStepRow, col) && !state.board[twoStepRow][col]) {
            moves.push({ from: { row, col }, to: { row: twoStepRow, col } });
          }
        }

        for (const deltaCol of [-1, 1]) {
          const targetCol = col + deltaCol;
          const targetRow = row + dir;
          if (!insideBoard(targetRow, targetCol)) {
            continue;
          }

          const targetPiece = state.board[targetRow][targetCol];
          if (targetPiece && targetPiece.color !== color) {
            if (targetRow === promotionRow) {
              for (const promotion of PROMOTIONS) {
                moves.push({
                  from: { row, col },
                  to: { row: targetRow, col: targetCol },
                  promotion,
                });
              }
            } else {
              moves.push({ from: { row, col }, to: { row: targetRow, col: targetCol } });
            }
          }

          if (
            enPassantTarget &&
            enPassantTarget.row === targetRow &&
            enPassantTarget.col === targetCol
          ) {
            moves.push({
              from: { row, col },
              to: { row: targetRow, col: targetCol },
              isEnPassant: true,
            });
          }
        }
      }

      if (piece.type === 'n') {
        for (const [dr, dc] of knightOffsets) {
          const targetRow = row + dr;
          const targetCol = col + dc;
          if (!insideBoard(targetRow, targetCol)) {
            continue;
          }
          const targetPiece = state.board[targetRow][targetCol];
          if (!targetPiece || targetPiece.color !== color) {
            moves.push({ from: { row, col }, to: { row: targetRow, col: targetCol } });
          }
        }
      }

      if (piece.type === 'b' || piece.type === 'r' || piece.type === 'q') {
        const directions =
          piece.type === 'b'
            ? bishopDirs
            : piece.type === 'r'
              ? rookDirs
              : [...bishopDirs, ...rookDirs];

        for (const [dr, dc] of directions) {
          let targetRow = row + dr;
          let targetCol = col + dc;
          while (insideBoard(targetRow, targetCol)) {
            const targetPiece = state.board[targetRow][targetCol];
            if (!targetPiece) {
              moves.push({ from: { row, col }, to: { row: targetRow, col: targetCol } });
            } else {
              if (targetPiece.color !== color) {
                moves.push({ from: { row, col }, to: { row: targetRow, col: targetCol } });
              }
              break;
            }
            targetRow += dr;
            targetCol += dc;
          }
        }
      }

      if (piece.type === 'k') {
        for (let dr = -1; dr <= 1; dr += 1) {
          for (let dc = -1; dc <= 1; dc += 1) {
            if (dr === 0 && dc === 0) {
              continue;
            }
            const targetRow = row + dr;
            const targetCol = col + dc;
            if (!insideBoard(targetRow, targetCol)) {
              continue;
            }
            const targetPiece = state.board[targetRow][targetCol];
            if (!targetPiece || targetPiece.color !== color) {
              moves.push({ from: { row, col }, to: { row: targetRow, col: targetCol } });
            }
          }
        }

        if (canCastle(state, color, 'K')) {
          moves.push({ from: { row, col }, to: { row, col: 6 } });
        }
        if (canCastle(state, color, 'Q')) {
          moves.push({ from: { row, col }, to: { row, col: 2 } });
        }
      }
    }
  }

  return moves;
}

function applyMoveInternal(state: GameState, move: Move, recordHistory: boolean): GameState {
  const board = cloneBoard(state.board);
  const castling: CastlingRights = { ...state.castling };

  const movingPiece = board[move.from.row][move.from.col];
  if (!movingPiece) {
    return state;
  }

  const toPiece = board[move.to.row][move.to.col];
  const isEnPassantCapture =
    movingPiece.type === 'p' &&
    move.from.col !== move.to.col &&
    !toPiece &&
    (move.isEnPassant || state.enPassant === coordToSquare(move.to));
  const isCastling = movingPiece.type === 'k' && Math.abs(move.to.col - move.from.col) === 2;

  board[move.from.row][move.from.col] = null;

  if (isEnPassantCapture) {
    const dir = movingPiece.color === 'w' ? -1 : 1;
    const capturedPawnRow = move.to.row - dir;
    board[capturedPawnRow][move.to.col] = null;
  }

  if (isCastling) {
    const row = move.from.row;
    if (move.to.col === 6) {
      const rook = board[row][7];
      board[row][7] = null;
      board[row][5] = rook;
    } else if (move.to.col === 2) {
      const rook = board[row][0];
      board[row][0] = null;
      board[row][3] = rook;
    }
  }

  const reachesLastRank =
    movingPiece.type === 'p' && (move.to.row === 0 || move.to.row === 7);
  const promotion = reachesLastRank ? move.promotion ?? 'q' : undefined;
  const placedPiece: Piece = {
    color: movingPiece.color,
    type: promotion ?? movingPiece.type,
  };
  board[move.to.row][move.to.col] = placedPiece;

  if (movingPiece.type === 'k') {
    if (movingPiece.color === 'w') {
      castling.wK = false;
      castling.wQ = false;
    } else {
      castling.bK = false;
      castling.bQ = false;
    }
  }

  if (movingPiece.type === 'r') {
    if (move.from.row === 7 && move.from.col === 0) {
      castling.wQ = false;
    }
    if (move.from.row === 7 && move.from.col === 7) {
      castling.wK = false;
    }
    if (move.from.row === 0 && move.from.col === 0) {
      castling.bQ = false;
    }
    if (move.from.row === 0 && move.from.col === 7) {
      castling.bK = false;
    }
  }

  if (toPiece && toPiece.type === 'r') {
    if (move.to.row === 7 && move.to.col === 0) {
      castling.wQ = false;
    }
    if (move.to.row === 7 && move.to.col === 7) {
      castling.wK = false;
    }
    if (move.to.row === 0 && move.to.col === 0) {
      castling.bQ = false;
    }
    if (move.to.row === 0 && move.to.col === 7) {
      castling.bK = false;
    }
  }

  const nextEnPassant =
    movingPiece.type === 'p' && Math.abs(move.to.row - move.from.row) === 2
      ? coordToSquare({
          row: move.from.row + (movingPiece.color === 'w' ? -1 : 1),
          col: move.from.col,
        })
      : null;

  const isCapture = Boolean(toPiece) || isEnPassantCapture;
  const normalizedMove: Move = promotion ? { ...move, promotion } : move;
  const nextHistory = recordHistory ? [...state.history, moveToUci(normalizedMove)] : state.history;

  return {
    ...state,
    board,
    turn: opponent(movingPiece.color),
    castling,
    enPassant: nextEnPassant,
    halfmove: movingPiece.type === 'p' || isCapture ? 0 : state.halfmove + 1,
    fullmove: state.fullmove + (movingPiece.color === 'b' ? 1 : 0),
    history: nextHistory,
    lastMove: {
      from: coordToSquare(move.from),
      to: coordToSquare(move.to),
    },
  };
}

function generateLegalMoves(state: GameState, color: Color): Move[] {
  const pseudoMoves = generatePseudoMoves(state, color);
  return pseudoMoves.filter((move) => {
    const simulated = applyMoveInternal(state, move, false);
    return !isInCheck(simulated, color);
  });
}

function evaluateGameState(state: GameState): GameState {
  if (state.result !== 'playing') {
    return state;
  }

  const legalMoves = generateLegalMoves(state, state.turn);
  if (legalMoves.length > 0) {
    return { ...state, result: 'playing', winner: null };
  }

  if (isInCheck(state, state.turn)) {
    return {
      ...state,
      result: 'checkmate',
      winner: opponent(state.turn),
    };
  }

  return {
    ...state,
    result: 'stalemate',
    winner: null,
  };
}

function sameMove(a: Move, b: Move): boolean {
  if (!coordsEqual(a.from, b.from) || !coordsEqual(a.to, b.to)) {
    return false;
  }
  if (a.promotion || b.promotion) {
    return a.promotion === b.promotion;
  }
  return true;
}

function normalizeBackendMove(raw: unknown): { from: string; to: string; promotion?: PromotionType } | null {
  if (typeof raw === 'string') {
    return parseUci(raw);
  }

  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const payload = raw as Record<string, unknown>;

  if (typeof payload.uci === 'string') {
    return parseUci(payload.uci);
  }

  if (typeof payload.move === 'string') {
    return parseUci(payload.move);
  }

  if (payload.move && typeof payload.move === 'object') {
    const nested = normalizeBackendMove(payload.move);
    if (nested) {
      return nested;
    }
  }

  if (typeof payload.from !== 'string' || typeof payload.to !== 'string') {
    return null;
  }

  const from = payload.from.trim().toLowerCase();
  const to = payload.to.trim().toLowerCase();
  if (!/^[a-h][1-8]$/.test(from) || !/^[a-h][1-8]$/.test(to)) {
    return null;
  }

  let promotion: PromotionType | undefined;
  if (typeof payload.promotion === 'string') {
    const p = payload.promotion.trim().toLowerCase();
    if (p === 'q' || p === 'r' || p === 'b' || p === 'n') {
      promotion = p;
    }
  }

  return { from, to, promotion };
}
function matchBackendMove(raw: unknown, legalMoves: Move[]): Move | null {
  const normalized = normalizeBackendMove(raw);
  if (!normalized) {
    return null;
  }

  const candidates = legalMoves.filter(
    (move) => coordToSquare(move.from) === normalized.from && coordToSquare(move.to) === normalized.to,
  );
  if (candidates.length === 0) {
    return null;
  }

  if (normalized.promotion) {
    const exact = candidates.find((move) => move.promotion === normalized.promotion);
    return exact ?? null;
  }

  const queenPromotion = candidates.find((move) => move.promotion === 'q');
  return queenPromotion ?? candidates[0];
}

async function requestAiMove(
  state: GameState,
  legalMoves: Move[],
): Promise<Move | null> {
  const payload = await getAIMove(toFEN(state));

  const direct = matchBackendMove(payload, legalMoves);
  if (direct) {
    return direct;
  }

  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    const extracted = [
      record.move,
      record.uci,
      { from: record.from, to: record.to, promotion: record.promotion },
    ];
    for (const candidate of extracted) {
      const found = matchBackendMove(candidate, legalMoves);
      if (found) {
        return found;
      }
    }
  }

  return null;
}

function toFEN(state: GameState): string {
  const rows: string[] = [];

  for (let row = 0; row < 8; row += 1) {
    let emptyCount = 0;
    let fenRow = '';
    for (let col = 0; col < 8; col += 1) {
      const piece = state.board[row][col];
      if (!piece) {
        emptyCount += 1;
        continue;
      }

      if (emptyCount > 0) {
        fenRow += String(emptyCount);
        emptyCount = 0;
      }

      const symbol = piece.type;
      fenRow += piece.color === 'w' ? symbol.toUpperCase() : symbol;
    }

    if (emptyCount > 0) {
      fenRow += String(emptyCount);
    }
    rows.push(fenRow);
  }

  const castling =
    `${state.castling.wK ? 'K' : ''}${state.castling.wQ ? 'Q' : ''}${state.castling.bK ? 'k' : ''}${state.castling.bQ ? 'q' : ''}` ||
    '-';

  return `${rows.join('/')} ${state.turn} ${castling} ${state.enPassant ?? '-'} ${state.halfmove} ${state.fullmove}`;
}

function App() {
  const [initialPersisted] = useState<PersistedAppState | null>(() => loadPersistedAppState());
  const initialClockMs = initialPersisted?.timeControlMs ?? DEFAULT_TIME_CONTROL_MS;
  const initialScreen: ScreenMode =
    initialPersisted?.screen === 'game' ? 'game' : 'home';
  const [uiTheme, setUiTheme] = useState<UiTheme>(() => loadUiTheme());
  const [screen, setScreen] = useState<ScreenMode>(initialScreen);
  const [game, setGame] = useState<GameState>(
    () => initialPersisted?.game ?? createInitialGame(),
  );
  const [selected, setSelected] = useState<Coord | null>(null);
  const [pendingQuitConfirm, setPendingQuitConfirm] = useState(false);
  const [pendingAnimation, setPendingAnimation] = useState<PendingAnimation | null>(null);
  const [pendingPromotion, setPendingPromotion] = useState<PendingPromotion | null>(null);
  const [promotionNotice, setPromotionNotice] = useState<string | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupFromHome, setSetupFromHome] = useState(false);
  const [setupColor, setSetupColor] = useState<Color>(() => initialPersisted?.humanColor ?? 'w');
  const [setupTimeControlMs, setSetupTimeControlMs] = useState<number>(initialClockMs);
  const [humanColor, setHumanColor] = useState<Color>(
    () => initialPersisted?.humanColor ?? 'w',
  );
  const [timeControlMs, setTimeControlMs] = useState<number>(initialClockMs);
  const [whiteClockMs, setWhiteClockMs] = useState<number>(
    () => initialPersisted?.whiteClockMs ?? initialClockMs,
  );
  const [blackClockMs, setBlackClockMs] = useState<number>(
    () => initialPersisted?.blackClockMs ?? initialClockMs,
  );
  const [startCountdown, setStartCountdown] = useState<number | null>(null);
  const [gameReady, setGameReady] = useState(() => initialScreen === 'game');
  const [aiThinking, setAiThinking] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [backendAvailable, setBackendAvailable] = useState(false);
  const [backendStatusText, setBackendStatusText] = useState('Checking backend...');
  const [dismissedReviewKey, setDismissedReviewKey] = useState('');
  const [gameEndSyncState, setGameEndSyncState] = useState<'idle' | 'sent' | 'failed'>('idle');
  const [showRestoredNotice, setShowRestoredNotice] = useState(initialScreen === 'game');
  const [error, setError] = useState<string | null>(null);
  const [homeMenuOpen, setHomeMenuOpen] = useState(false);
  const [customizationOpen, setCustomizationOpen] = useState(false);
  const [memoryAdminKey, setMemoryAdminKey] = useState('');
  const [memoryBusy, setMemoryBusy] = useState(false);
  const [memoryStatus, setMemoryStatus] = useState<string | null>(null);
  const aiRequestPosition = useRef<string>('');
  const gameSessionRef = useRef(0);
  const moveAnimationTimerRef = useRef<number | null>(null);
  const notifiedGameEndRef = useRef<string>('');
  const homeMenuRef = useRef<HTMLDivElement | null>(null);

  const aiColor: Color = humanColor === 'w' ? 'b' : 'w';
  const legalMoves = useMemo(() => generateLegalMoves(game, game.turn), [game]);
  const selectedMoves = useMemo(
    () => (selected ? legalMoves.filter((move) => coordsEqual(move.from, selected)) : []),
    [legalMoves, selected],
  );

  const checkedKing = game.result === 'playing' ? findKing(game.board, game.turn) : null;
  const boardRows = useMemo(
    () => (humanColor === 'w' ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0]),
    [humanColor],
  );
  const boardCols = useMemo(
    () => (humanColor === 'w' ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0]),
    [humanColor],
  );
  const animationVector = useMemo(() => {
    if (!pendingAnimation) {
      return null;
    }

    const fromRowIndex = boardRows.indexOf(pendingAnimation.from.row);
    const toRowIndex = boardRows.indexOf(pendingAnimation.to.row);
    const fromColIndex = boardCols.indexOf(pendingAnimation.from.col);
    const toColIndex = boardCols.indexOf(pendingAnimation.to.col);

    if (fromRowIndex < 0 || toRowIndex < 0 || fromColIndex < 0 || toColIndex < 0) {
      return null;
    }

    return {
      dx: toColIndex - fromColIndex,
      dy: toRowIndex - fromRowIndex,
    };
  }, [boardCols, boardRows, pendingAnimation]);
  const appStyle = useMemo(
    () =>
      ({
        '--light-square': uiTheme.lightSquare,
        '--dark-square': uiTheme.darkSquare,
      }) as CSSProperties,
    [uiTheme],
  );

  const statusText = useMemo(() => {
    if (setupOpen) {
      return 'Choose your side and clock to start a new match.';
    }
    if (startCountdown !== null) {
      return `Match starts in ${startCountdown}s...`;
    }
    if (!gameReady) {
      return 'Preparing board...';
    }
    if (game.result === 'timeout') {
      return game.winner === humanColor ? 'Time out. You win on time.' : 'Time out. AI wins on time.';
    }
    if (game.result === 'checkmate') {
      return game.winner === humanColor ? 'Checkmate. You win.' : 'Checkmate. AI wins.';
    }
    if (game.result === 'stalemate') {
      return 'Stalemate.';
    }

    const checked = checkedKing ? ' Check.' : '';
    if (game.turn === humanColor) {
      return `Your move (${humanColor === 'w' ? 'White' : 'Black'}).${checked}`;
    }
    return aiThinking ? `AI is thinking...${checked}` : `AI to move.${checked}`;
  }, [aiThinking, checkedKing, gameReady, game.result, game.turn, game.winner, humanColor, setupOpen, startCountdown]);

  const moveRows = useMemo(() => {
    const rows: Array<{ no: number; white: string; black: string }> = [];
    for (let i = 0; i < game.history.length; i += 2) {
      rows.push({
        no: Math.floor(i / 2) + 1,
        white: game.history[i] ?? '',
        black: game.history[i + 1] ?? '',
      });
    }
    return rows;
  }, [game.history]);

  const gameOverTitle = useMemo(() => {
    if (game.result === 'checkmate') {
      return game.winner === humanColor ? 'You Won' : 'AI Won';
    }
    if (game.result === 'timeout') {
      return game.winner === humanColor ? 'You Won On Time' : 'AI Won On Time';
    }
    if (game.result === 'stalemate') {
      return 'Draw';
    }
    return '';
  }, [game.result, game.winner, humanColor]);

  const gameOverReason = useMemo(() => {
    if (game.result === 'checkmate') {
      return 'Checkmate';
    }
    if (game.result === 'timeout') {
      return 'Time Out';
    }
    if (game.result === 'stalemate') {
      return 'Stalemate';
    }
    return '';
  }, [game.result]);

  const reviewText = useMemo(() => {
    const chunks: string[] = [];
    for (let i = 0; i < game.history.length; i += 2) {
      const moveNo = Math.floor(i / 2) + 1;
      const white = game.history[i] ?? '';
      const black = game.history[i + 1] ?? '';
      chunks.push(`${moveNo}. ${white}${black ? ` ${black}` : ''}`);
    }
    return chunks.join('  ');
  }, [game.history]);

  const gameResultKey = useMemo(
    () => (game.result === 'playing' ? '' : `${game.result}|${toFEN(game)}`),
    [game],
  );
  const gameReviewVisible = gameResultKey !== '' && dismissedReviewKey !== gameResultKey;

  const clearMoveAnimationTimer = useCallback(() => {
    if (moveAnimationTimerRef.current !== null) {
      window.clearTimeout(moveAnimationTimerRef.current);
      moveAnimationTimerRef.current = null;
    }
  }, []);

  const applyLegalMoveWithGuard = useCallback((
    move: Move,
    guard?: (state: GameState) => boolean,
  ): boolean => {
    let applied = false;

    setGame((prev) => {
      if (guard && !guard(prev)) {
        return prev;
      }

      const legalNow = generateLegalMoves(prev, prev.turn);
      const legalMove = legalNow.find((candidate) => sameMove(candidate, move));
      if (!legalMove) {
        return prev;
      }

      applied = true;
      return evaluateGameState(applyMoveInternal(prev, legalMove, true));
    });

    return applied;
  }, []);

  const animateThenApplyMove = useCallback((
    move: Move,
    options?: {
      guard?: (state: GameState) => boolean;
      onSettled?: (applied: boolean) => void;
    },
  ) => {
    const movingPiece = game.board[move.from.row][move.from.col];
    if (!movingPiece) {
      const applied = applyLegalMoveWithGuard(move, options?.guard);
      options?.onSettled?.(applied);
      return;
    }

    clearMoveAnimationTimer();
    setPendingAnimation({
      from: move.from,
      to: move.to,
      piece: movingPiece,
    });

    moveAnimationTimerRef.current = window.setTimeout(() => {
      moveAnimationTimerRef.current = null;
      setPendingAnimation(null);
      const applied = applyLegalMoveWithGuard(move, options?.guard);
      options?.onSettled?.(applied);
    }, MOVE_ANIMATION_MS);
  }, [applyLegalMoveWithGuard, clearMoveAnimationTimer, game.board]);

  const playMove = (move: Move) => {
    setSelected(null);
    setError(null);
    animateThenApplyMove(move);
  };

  const handleSelectPromotion = (promotion: PromotionType) => {
    if (!pendingPromotion) {
      return;
    }

    const promotedMove =
      pendingPromotion.options.find((move) => move.promotion === promotion) ??
      pendingPromotion.options[0];
    if (!promotedMove) {
      setPendingPromotion(null);
      return;
    }

    setPendingPromotion(null);
    setPromotionNotice(`You promoted pawn to ${promotionTypeLabel(promotedMove.promotion ?? 'q')}.`);
    playMove(promotedMove);
  };

  const startNewGame = (nextHumanColor: Color, nextTimeControlMs: number) => {
    gameSessionRef.current += 1;
    aiRequestPosition.current = '';
    notifiedGameEndRef.current = '';
    setGameEndSyncState('idle');
    clearMoveAnimationTimer();
    setGame(createInitialGame());
    setSelected(null);
    setPendingQuitConfirm(false);
    setPendingAnimation(null);
    setPendingPromotion(null);
    setPromotionNotice(null);
    setDismissedReviewKey('');
    setScreen('game');
    setSetupOpen(false);
    setSetupFromHome(false);
    setCustomizationOpen(false);
    setHomeMenuOpen(false);
    setSetupColor(nextHumanColor);
    setSetupTimeControlMs(nextTimeControlMs);
    setError(null);
    setAiThinking(false);
    setTimeControlMs(nextTimeControlMs);
    setWhiteClockMs(nextTimeControlMs);
    setBlackClockMs(nextTimeControlMs);
    setHumanColor(nextHumanColor);
    setGameReady(false);
    setStartCountdown(START_DELAY_SECONDS);
  };

  const handleOpenHomeNewMatch = () => {
    setError(null);
    setPendingPromotion(null);
    setScreen('game');
    setSetupFromHome(true);
    setHomeMenuOpen(false);
    setCustomizationOpen(false);
    if (gameResultKey) {
      setDismissedReviewKey(gameResultKey);
    }
    setSetupColor(humanColor);
    setSetupTimeControlMs(timeControlMs);
    setSetupOpen(true);
  };

  const handleOpenCustomization = () => {
    setHomeMenuOpen(false);
    setCustomizationOpen(true);
  };

  const handleOpenAiMemory = () => {
    setHomeMenuOpen(false);
    setCustomizationOpen(false);
    setMemoryStatus(null);
    setScreen('ai-memory');
  };

  const handleBackFromAiMemory = () => {
    setMemoryStatus(null);
    setScreen('home');
  };

  const handleThemeColorChange = (
    key: 'lightSquare' | 'darkSquare',
    value: string,
  ) => {
    setUiTheme((prev) => ({
      ...prev,
      [key]: value,
    }));
  };

  const handlePieceThemeChange = (pieceTheme: PieceTheme) => {
    setUiTheme((prev) => ({
      ...prev,
      pieceTheme,
    }));
  };

  const handleResetTheme = () => {
    setUiTheme(DEFAULT_UI_THEME);
  };

  const handleEraseAiMemory = async () => {
    const key = memoryAdminKey.trim();
    if (!key) {
      setMemoryStatus('Enter admin key to erase memory.');
      return;
    }

    if (!window.confirm('Erase AI memory permanently?')) {
      return;
    }

    setMemoryBusy(true);
    setMemoryStatus(null);

    try {
      await resetAiMemory(key);
      setMemoryStatus('AI memory erased successfully.');
      setMemoryAdminKey('');
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      if (message === 'UNAUTHORIZED' || message.toLowerCase().includes('invalid admin key')) {
        setMemoryStatus('Invalid admin key.');
      } else {
        setMemoryStatus('Failed to erase AI memory.');
      }
    } finally {
      setMemoryBusy(false);
    }
  };

  const handleStartConfiguredGame = async () => {
    if (!backendAvailable) {
      setError(`Backend unavailable at ${BASE_URL}. Connect backend to start match.`);
      return;
    }

    try {
      await stopTraining();
    } catch {
      setBackendAvailable(false);
      setError(`Backend unavailable at ${BASE_URL}. Connect backend to start match.`);
      return;
    }

    setError(null);
    startNewGame(setupColor, setupTimeControlMs);
  };

  const handleCloseSetup = () => {
    setSetupOpen(false);
    if (setupFromHome) {
      setScreen('home');
    }
    setSetupFromHome(false);
  };

  const handleQuitGame = async () => {
    setPendingQuitConfirm(false);
    setAiThinking(false);
    clearMoveAnimationTimer();
    try {
      await notifyGameEnd(toFEN(game));
      setBackendStatusText('Backend status: game end sent');
      setBackendAvailable(true);
    } catch {
      setError(`Backend unavailable at ${BASE_URL}. Quit sent failed.`);
    }

    setGame(createInitialGame());
    setSelected(null);
    setPendingAnimation(null);
    setPendingPromotion(null);
    setPromotionNotice(null);
    setDismissedReviewKey('');
    setGameEndSyncState('idle');
    setSetupOpen(false);
    setSetupFromHome(false);
    setCustomizationOpen(false);
    setHomeMenuOpen(false);
    setStartCountdown(null);
    setGameReady(false);
    setScreen('home');
  };

  const handleGoHomeFromGameOver = () => {
    setDismissedReviewKey(gameResultKey);
    setSetupOpen(false);
    setScreen('home');
  };

  const handleNewMatchFromGameOver = () => {
    setDismissedReviewKey(gameResultKey);
    setSetupColor(humanColor);
    setSetupTimeControlMs(timeControlMs);
    setSetupFromHome(false);
    setSetupOpen(true);
  };

  const onSquareClick = (coord: Coord) => {
    if (
      screen !== 'game' ||
      !gameReady ||
      setupOpen ||
      startCountdown !== null ||
      game.result !== 'playing' ||
      game.turn !== humanColor ||
      aiThinking ||
      pendingAnimation ||
      pendingPromotion
    ) {
      return;
    }

    const clickedPiece = game.board[coord.row][coord.col];

    if (!selected) {
      if (
        clickedPiece &&
        clickedPiece.color === humanColor &&
        legalMoves.some((move) => coordsEqual(move.from, coord))
      ) {
        setSelected(coord);
      }
      return;
    }

    if (coordsEqual(selected, coord)) {
      setSelected(null);
      return;
    }

    const destinationMoves = selectedMoves.filter((move) => coordsEqual(move.to, coord));
    if (destinationMoves.length > 0) {
      const promotionMoves = destinationMoves.filter((move) => Boolean(move.promotion));
      if (promotionMoves.length > 0) {
        setSelected(null);
        setPendingPromotion({
          from: selected,
          to: coord,
          options: promotionMoves,
        });
      } else {
        playMove(destinationMoves[0]);
      }
      return;
    }

    if (
      clickedPiece &&
      clickedPiece.color === humanColor &&
      legalMoves.some((move) => coordsEqual(move.from, coord))
    ) {
      setSelected(coord);
      return;
    }

    setSelected(null);
  };

  useEffect(() => {
    const frameId = window.requestAnimationFrame(() => {
      setMounted(true);
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, []);

  useEffect(() => {
    return () => {
      clearMoveAnimationTimer();
    };
  }, [clearMoveAnimationTimer]);

  useEffect(() => {
    if (!showRestoredNotice) {
      return;
    }

    const timer = window.setTimeout(() => {
      setShowRestoredNotice(false);
    }, 2200);

    return () => {
      window.clearTimeout(timer);
    };
  }, [showRestoredNotice]);

  useEffect(() => {
    if (!promotionNotice) {
      return;
    }

    const timer = window.setTimeout(() => {
      setPromotionNotice(null);
    }, 4200);

    return () => {
      window.clearTimeout(timer);
    };
  }, [promotionNotice]);

  useEffect(() => {
    saveUiTheme(uiTheme);
  }, [uiTheme]);

  useEffect(() => {
    if (!homeMenuOpen) {
      return;
    }

    const onDocumentClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (homeMenuRef.current && !homeMenuRef.current.contains(target)) {
        setHomeMenuOpen(false);
      }
    };

    window.addEventListener('mousedown', onDocumentClick);
    return () => {
      window.removeEventListener('mousedown', onDocumentClick);
    };
  }, [homeMenuOpen]);

  useEffect(() => {
    let cancelled = false;

    const updateStatus = async () => {
      try {
        const payload = await getStatus();
        if (cancelled) {
          return;
        }

        if (payload && typeof payload === 'object' && 'status' in payload) {
          const statusValue = (payload as Record<string, unknown>).status;
          setBackendStatusText(`Backend status: ${String(statusValue)}`);
          setBackendAvailable(true);
        } else {
          setBackendStatusText('Backend status: online');
          setBackendAvailable(true);
        }
      } catch {
        if (!cancelled) {
          setBackendStatusText(`Backend status: unavailable (${BASE_URL})`);
          setBackendAvailable(false);
        }
      }
    };

    updateStatus();
    const intervalId = window.setInterval(updateStatus, 15000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    if (startCountdown === null) {
      return;
    }

    const timer = window.setTimeout(() => {
      setStartCountdown((prev) => {
        if (prev === null) {
          return prev;
        }
        if (prev <= 1) {
          setGameReady(true);
          return null;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      window.clearTimeout(timer);
    };
  }, [startCountdown]);

  useEffect(() => {
    if (game.result === 'playing') {
      notifiedGameEndRef.current = '';
      return;
    }

    const fen = toFEN(game);
    const notifyKey = `${game.result}|${fen}`;
    if (notifiedGameEndRef.current === notifyKey) {
      return;
    }
    notifiedGameEndRef.current = notifyKey;

    notifyGameEnd(fen)
      .then(() => {
        setGameEndSyncState('sent');
      })
      .catch(() => {
        setGameEndSyncState('failed');
      });
  }, [game]);

  useEffect(() => {
    if (
      screen !== 'game' ||
      !gameReady ||
      setupOpen ||
      startCountdown !== null ||
      game.result !== 'playing' ||
      pendingAnimation !== null
    ) {
      return;
    }

    const timer = window.setInterval(() => {
      if (game.turn === 'w') {
        setWhiteClockMs((prev) => {
          const next = Math.max(0, prev - CLOCK_TICK_MS);
          if (next === 0 && prev > 0) {
            setGame((current) =>
              current.result === 'playing'
                ? {
                    ...current,
                    result: 'timeout',
                    winner: 'b',
                  }
                : current,
            );
            setAiThinking(false);
          }
          return next;
        });
      } else {
        setBlackClockMs((prev) => {
          const next = Math.max(0, prev - CLOCK_TICK_MS);
          if (next === 0 && prev > 0) {
            setGame((current) =>
              current.result === 'playing'
                ? {
                    ...current,
                    result: 'timeout',
                    winner: 'w',
                  }
                : current,
            );
            setAiThinking(false);
          }
          return next;
        });
      }
    }, CLOCK_TICK_MS);

    return () => {
      window.clearInterval(timer);
    };
  }, [game.turn, game.result, gameReady, pendingAnimation, screen, setupOpen, startCountdown]);

  useEffect(() => {
    savePersistedAppState({
      game,
      humanColor,
      whiteClockMs,
      blackClockMs,
      timeControlMs,
      screen: screen === 'game' ? 'game' : 'home',
    });
  }, [blackClockMs, game, humanColor, screen, timeControlMs, whiteClockMs]);

  useEffect(() => {
    if (
      screen !== 'game' ||
      !gameReady ||
      setupOpen ||
      startCountdown !== null ||
      game.result !== 'playing' ||
      game.turn !== aiColor
    ) {
      return;
    }

    const positionKey = toFEN(game);
    if (aiRequestPosition.current === positionKey) {
      return;
    }
    aiRequestPosition.current = positionKey;
    const sessionAtRequest = gameSessionRef.current;

    let cancelled = false;

    const run = async () => {
      if (gameSessionRef.current !== sessionAtRequest) {
        return;
      }

      if (!cancelled) {
        setAiThinking(true);
      }

      const legal = generateLegalMoves(game, aiColor);
      if (legal.length === 0) {
        if (!cancelled) {
          setAiThinking(false);
        }
        return;
      }

      let chosen: Move | null = null;
      let backendDown = false;
      try {
        chosen = await requestAiMove(game, legal);
      } catch {
        backendDown = true;
      }

      if (cancelled || gameSessionRef.current !== sessionAtRequest) {
        return;
      }

      if (backendDown) {
        if (!cancelled) {
          setBackendAvailable(false);
          setError(`Backend unavailable at ${BASE_URL}/api/ai-move. Game paused.`);
          setGameReady(false);
          setAiThinking(false);
        }
        return;
      }

      if (!chosen) {
        if (!cancelled) {
          setError('Backend move format not recognized. Game paused.');
          setGameReady(false);
          setAiThinking(false);
        }
        return;
      }

      if (!cancelled) {
        setError(null);
        if (chosen.promotion) {
          setPromotionNotice(`AI promoted pawn to ${promotionTypeLabel(chosen.promotion)}.`);
        }
      }

      if (!chosen || cancelled) {
        if (!cancelled) {
          setAiThinking(false);
        }
        return;
      }

      animateThenApplyMove(chosen, {
        guard: (prev) =>
          gameSessionRef.current === sessionAtRequest &&
          toFEN(prev) === positionKey &&
          prev.turn === aiColor &&
          prev.result === 'playing',
        onSettled: () => {
          if (!cancelled && gameSessionRef.current === sessionAtRequest) {
            setAiThinking(false);
          }
        },
      });
    };

    run();

    return () => {
      cancelled = true;
    };
  }, [aiColor, animateThenApplyMove, game, gameReady, screen, setupOpen, startCountdown]);

  return (
    <div className={`app ${mounted ? 'loaded' : 'loading'}`} style={appStyle}>
      {screen === 'home' && (
        <main className="home-layout">
          <section className="home-card">
            <div className="home-topbar" ref={homeMenuRef}>
              <button
                className="home-menu-trigger"
                aria-label="Open home menu"
                onClick={() => setHomeMenuOpen((prev) => !prev)}
              >
                ...
              </button>
              {homeMenuOpen && (
                <div className="home-menu-dropdown">
                  <button onClick={handleOpenCustomization}>Customization</button>
                  <button onClick={handleOpenAiMemory}>AI Memory</button>
                </div>
              )}
            </div>
            <div className="home-card-grid">
              <div className="home-identity">
                <p className="home-kicker">Tournament Lobby</p>
                <h1>Chess AI Arena</h1>
                <p className="home-subtitle">
                  Human vs AI training board with backend-driven professional gameplay.
                </p>

                <div className="home-pill-row">
                  <span className={`home-status-pill ${backendAvailable ? 'online' : 'offline'}`}>
                    {backendAvailable ? 'Backend Online' : 'Backend Offline'}
                  </span>
                  <span className="home-status-pill neutral">Human vs AI</span>
                </div>

                <button
                  className="home-new-match"
                  onClick={handleOpenHomeNewMatch}
                  disabled={!backendAvailable}
                >
                  Start New Match
                </button>

                <p className="backend-note home-backend-line">{backendStatusText}</p>
                {!backendAvailable && (
                  <p className="control-note">Backend must be online before starting a match.</p>
                )}
                {error && <p className="error">{error}</p>}
              </div>

              <div className="home-board-preview" aria-hidden="true">
                <div className="home-board-frame">
                  <div className="home-board-surface">
                    {Array.from({ length: 16 }, (_, idx) => (
                      <span
                        key={`preview-${idx}`}
                        className={`home-preview-square ${idx % 2 === Math.floor(idx / 4) % 2 ? 'light' : 'dark'}`}
                      />
                    ))}
                  </div>
                  <p className="home-preview-label">Rated AI Arena</p>
                </div>
              </div>
            </div>

            {customizationOpen && (
              <section className="home-customization">
                <h2>Board Customization</h2>
                <p>Customize only board colors and chess piece style.</p>

                <div className="customization-grid">
                  <label>
                    Light Squares
                    <input
                      type="color"
                      value={uiTheme.lightSquare}
                      onChange={(event) => handleThemeColorChange('lightSquare', event.target.value)}
                    />
                  </label>
                  <label>
                    Dark Squares
                    <input
                      type="color"
                      value={uiTheme.darkSquare}
                      onChange={(event) => handleThemeColorChange('darkSquare', event.target.value)}
                    />
                  </label>
                </div>

                <div className="setup-group">
                  <span className="setup-label">Piece Style</span>
                  <div className="setup-options">
                    <button
                      className={uiTheme.pieceTheme === 'uscf' ? 'active' : ''}
                      onClick={() => handlePieceThemeChange('uscf')}
                    >
                      USCF 3D
                    </button>
                    <button
                      className={uiTheme.pieceTheme === 'alpha' ? 'active' : ''}
                      onClick={() => handlePieceThemeChange('alpha')}
                    >
                      Alpha
                    </button>
                    <button
                      className={uiTheme.pieceTheme === 'wikipedia' ? 'active' : ''}
                      onClick={() => handlePieceThemeChange('wikipedia')}
                    >
                      Wikipedia
                    </button>
                  </div>
                </div>

                <div className="customization-actions">
                  <button onClick={handleResetTheme}>Reset Default</button>
                  <button className="danger" onClick={() => setCustomizationOpen(false)}>
                    Done
                  </button>
                </div>
              </section>
            )}
          </section>
        </main>
      )}

      {screen === 'ai-memory' && (
        <main className="home-layout">
          <section className="home-card ai-memory-card">
            <h1>AI Memory</h1>
            <p>Erase backend AI memory cache and training memory.</p>

            <div className="memory-form">
              <label htmlFor="memory-admin-key">Admin Key</label>
              <input
                id="memory-admin-key"
                type="password"
                value={memoryAdminKey}
                onChange={(event) => setMemoryAdminKey(event.target.value)}
                placeholder="Enter admin key"
                autoComplete="off"
              />
            </div>

            <p className="backend-note">{backendStatusText}</p>
            {memoryStatus && (
              <p className={memoryStatus.includes('successfully') ? 'restore-note' : 'error'}>
                {memoryStatus}
              </p>
            )}

            <div className="ai-memory-actions">
              <button onClick={handleBackFromAiMemory}>Back Home</button>
              <button
                className="danger"
                onClick={handleEraseAiMemory}
                disabled={memoryBusy || !backendAvailable}
              >
                {memoryBusy ? 'Erasing...' : 'Erase AI Memory'}
              </button>
            </div>
          </section>
        </main>
      )}

      {screen === 'game' && (
        <>
          <header className="hero">
            <h1>Chess AI Arena</h1>
            <p>Human vs AI only. Your backend decides AI moves.</p>
          </header>

          <main className="layout">
            <section className="board-card">
              <div className="board">
                {boardRows.map((row) => (
                  <div className="board-row" key={`row-${row}`}>
                    <span className="rank-label">{8 - row}</span>
                    {boardCols.map((col) => {
                      const coord = { row, col };
                      const square = coordToSquare(coord);
                      const piece = game.board[row][col];
                      const targetMoves = selectedMoves.filter((move) => coordsEqual(move.to, coord));
                      const legalTarget = targetMoves.length > 0;
                      const captureTarget = targetMoves.some(
                        (move) => move.isEnPassant || Boolean(game.board[move.to.row][move.to.col]),
                      );

                      const isSelected = selected ? coordsEqual(selected, coord) : false;
                      const isLastMove =
                        game.lastMove !== null &&
                        (game.lastMove.from === square || game.lastMove.to === square);
                      const isCheckSquare = checkedKing ? coordsEqual(checkedKing, coord) : false;
                      const isLight = (row + col) % 2 === 1;
                      const isAnimatingSource =
                        pendingAnimation !== null && coordsEqual(pendingAnimation.from, coord);
                      const disabled =
                        !gameReady ||
                        setupOpen ||
                        startCountdown !== null ||
                        game.turn !== humanColor ||
                        game.result !== 'playing' ||
                        aiThinking ||
                        pendingAnimation !== null ||
                        pendingPromotion !== null;

                      const movingStyle: CSSProperties | undefined =
                        isAnimatingSource && animationVector
                          ? ({
                              '--move-dx': animationVector.dx,
                              '--move-dy': animationVector.dy,
                              '--move-ms': `${MOVE_ANIMATION_MS}ms`,
                            } as CSSProperties)
                          : undefined;

                      return (
                        <button
                          key={square}
                          className={[
                            'square',
                            isLight ? 'light' : 'dark',
                            isSelected ? 'selected' : '',
                            isLastMove ? 'last-move' : '',
                            isCheckSquare ? 'checked' : '',
                          ]
                            .filter(Boolean)
                            .join(' ')}
                          onClick={() => onSquareClick(coord)}
                          disabled={disabled}
                        >
                          {piece && !isAnimatingSource && (
                            <span className="piece">
                              <img
                                className="piece-image"
                                src={pieceImageUrl(uiTheme.pieceTheme, piece)}
                                alt=""
                                draggable={false}
                              />
                            </span>
                          )}
                          {isAnimatingSource && pendingAnimation && (
                            <span
                              className="piece piece-moving"
                              style={movingStyle}
                            >
                              <img
                                className="piece-image"
                                src={pieceImageUrl(uiTheme.pieceTheme, pendingAnimation.piece)}
                                alt=""
                                draggable={false}
                              />
                            </span>
                          )}
                          {!piece && legalTarget && <span className="target-dot" />}
                          {piece && legalTarget && <span className={`target-ring ${captureTarget ? 'capture' : ''}`} />}
                        </button>
                      );
                    })}
                    <span className="rank-label">{8 - row}</span>
                  </div>
                ))}

                <div className="files-row">
                  <span className="file-spacer" />
                  {boardCols.map((col) => (
                    <span className="file-label" key={`file-${col}`}>
                      {FILES[col]}
                    </span>
                  ))}
                  <span className="file-spacer" />
                </div>
              </div>
            </section>

            <aside className="side-card">
              <section className="panel">
                <h2>Status</h2>
                <p>{statusText}</p>
                <p className="backend-note">{backendStatusText}</p>
                {showRestoredNotice && <p className="restore-note">Previous game restored after reload.</p>}
                {promotionNotice && <p className="restore-note">{promotionNotice}</p>}
                {error && <p className="error">{error}</p>}
              </section>

              <section className="panel">
                <h2>Clocks</h2>
                <div className="clock-list">
                  <div
                    className={`clock-row ${
                      gameReady && game.result === 'playing' && game.turn === 'w' ? 'active' : ''
                    }`}
                  >
                    <span className="clock-label">White</span>
                    <span className="clock-time">{formatClock(whiteClockMs)}</span>
                  </div>
                  <div
                    className={`clock-row ${
                      gameReady && game.result === 'playing' && game.turn === 'b' ? 'active' : ''
                    }`}
                  >
                    <span className="clock-label">Black</span>
                    <span className="clock-time">{formatClock(blackClockMs)}</span>
                  </div>
                </div>
              </section>

              <section className="panel">
                <h2>Controls</h2>
                <button className="quit" onClick={() => setPendingQuitConfirm(true)}>
                  Quit Game
                </button>
                <p className="control-note">Quit game to return home and start a new match.</p>
              </section>

              <section className="panel moves-panel">
                <h2>Moves</h2>
                <div className="moves-table">
                  <div className="moves-head">
                    <span>#</span>
                    <span>White</span>
                    <span>Black</span>
                  </div>
                  {moveRows.length === 0 && <p className="empty-moves">No moves yet.</p>}
                  {moveRows.map((row) => (
                    <div className="moves-row" key={`move-${row.no}`}>
                      <span>{row.no}</span>
                      <span>{row.white}</span>
                      <span>{row.black}</span>
                    </div>
                  ))}
                </div>
              </section>
            </aside>
          </main>

          {startCountdown !== null && (
            <div className="countdown-overlay">
              <div className="countdown-modal">
                <p>Round Begins In</p>
                <h2>{startCountdown}</h2>
              </div>
            </div>
          )}

          {pendingPromotion && (
            <div className="promotion-overlay">
              <div className="promotion-modal">
                <h3>Choose Promotion Piece</h3>
                <div className="promotion-options">
                  {PROMOTIONS.filter((type) =>
                    pendingPromotion.options.some((move) => move.promotion === type),
                  ).map((type) => (
                    <button
                      key={type}
                      onClick={() => handleSelectPromotion(type)}
                      aria-label={`Promote to ${promotionTypeLabel(type)}`}
                    >
                      <img
                        className="promotion-piece-image"
                        src={pieceImageUrl(uiTheme.pieceTheme, { color: humanColor, type })}
                        alt={promotionTypeLabel(type)}
                        draggable={false}
                      />
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {gameReviewVisible && game.result !== 'playing' && (
            <div className="gameover-overlay">
              <div className="gameover-modal">
                <h3>{gameOverTitle}</h3>
                <p className="gameover-subtitle">{gameOverReason}</p>

                <div className="gameover-summary">
                  <div>
                    <span>Result</span>
                    <strong>{gameOverReason}</strong>
                  </div>
                  <div>
                    <span>Total Moves</span>
                    <strong>{game.history.length}</strong>
                  </div>
                  <div>
                    <span>Final FEN</span>
                    <strong className="fen-value">{toFEN(game)}</strong>
                  </div>
                  <div>
                    <span>Backend Sync</span>
                    <strong>
                      {gameEndSyncState === 'sent'
                        ? 'Sent'
                        : gameEndSyncState === 'failed'
                          ? 'Failed'
                          : 'Sending...'}
                    </strong>
                  </div>
                </div>

                <div className="gameover-review">
                  <h4>Game Review</h4>
                  {moveRows.length === 0 ? (
                    <p>No moves available.</p>
                  ) : (
                    <div className="gameover-moves">
                      {moveRows.map((row) => (
                        <div key={`review-${row.no}`} className="gameover-move-row">
                          <span>{row.no}.</span>
                          <span>{row.white || '-'}</span>
                          <span>{row.black || '-'}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {reviewText && <p className="review-line">{reviewText}</p>}
                </div>

                <div className="gameover-actions">
                  <button onClick={handleGoHomeFromGameOver}>Go Home</button>
                  <button className="danger" onClick={handleNewMatchFromGameOver}>
                    New Match
                  </button>
                </div>
              </div>
            </div>
          )}

          {pendingQuitConfirm && (
            <div className="confirm-overlay">
              <div className="confirm-modal">
                <h3>Quit Current Game?</h3>
                <p>Current game will end and home screen will open.</p>
                <div className="confirm-actions">
                  <button onClick={() => setPendingQuitConfirm(false)}>Cancel</button>
                  <button className="danger" onClick={handleQuitGame}>
                    Quit Game
                  </button>
                </div>
              </div>
            </div>
          )}

          {setupOpen && (
            <div className="setup-overlay">
              <div className="setup-modal">
                <h3>New Match Setup</h3>
                <p>Choose your side and time control. Match starts after a 4 second countdown.</p>

                <div className="setup-group">
                  <span className="setup-label">Play As</span>
                  <div className="setup-options">
                    <button
                      className={setupColor === 'w' ? 'active' : ''}
                      onClick={() => setSetupColor('w')}
                    >
                      White
                    </button>
                    <button
                      className={setupColor === 'b' ? 'active' : ''}
                      onClick={() => setSetupColor('b')}
                    >
                      Black
                    </button>
                  </div>
                </div>

                <div className="setup-group">
                  <span className="setup-label">Time Control</span>
                  <div className="setup-options">
                    {TIME_CONTROL_OPTIONS.map((option) => (
                      <button
                        key={option.ms}
                        className={setupTimeControlMs === option.ms ? 'active' : ''}
                        onClick={() => setSetupTimeControlMs(option.ms)}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
                {!backendAvailable && (
                  <p className="error">Backend is offline. Connect backend to start match.</p>
                )}

                <div className="setup-actions">
                  <button onClick={handleCloseSetup}>Close</button>
                  <button
                    className="danger"
                    onClick={handleStartConfiguredGame}
                    disabled={!backendAvailable}
                  >
                    Start Match
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default App;
