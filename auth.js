const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const INSTANCES_FILE = path.join(DATA_DIR, 'instances.json');

const JWT_SECRET = process.env.JWT_SECRET || 'fallback-dev-secret-change-me';

// ─── Data Dir ───

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ─── Users ───

let _users = null;

function loadUsers() {
  if (_users) return _users;
  try {
    _users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch {
    _users = [];
  }
  return _users;
}

function saveUsers(users) {
  _users = users;
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// ─── Instances ───

let _instances = null;

function loadInstances() {
  if (_instances) return _instances;
  try {
    _instances = JSON.parse(fs.readFileSync(INSTANCES_FILE, 'utf8'));
  } catch {
    _instances = {};
  }
  return _instances;
}

function saveInstances(mapping) {
  _instances = mapping;
  fs.writeFileSync(INSTANCES_FILE, JSON.stringify(mapping, null, 2));
}

// ─── Auth ───

async function registerUser(email, password) {
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Email invalido');
  }
  if (!password || password.length < 6) {
    throw new Error('Senha deve ter no minimo 6 caracteres');
  }

  const users = loadUsers();
  const exists = users.find(u => u.email.toLowerCase() === email.toLowerCase());
  if (exists) throw new Error('Email ja cadastrado');

  const passwordHash = await bcrypt.hash(password, 10);
  const user = {
    id: crypto.randomUUID(),
    email: email.toLowerCase().trim(),
    passwordHash,
    role: users.length === 0 ? 'admin' : 'user',
    createdAt: new Date().toISOString(),
  };

  users.push(user);
  saveUsers(users);

  const { passwordHash: _, ...safe } = user;
  return safe;
}

async function loginUser(email, password) {
  if (!email || !password) throw new Error('Email e senha obrigatorios');

  const users = loadUsers();
  const user = users.find(u => u.email.toLowerCase() === email.toLowerCase().trim());
  if (!user) throw new Error('Email ou senha incorretos');

  const match = await bcrypt.compare(password, user.passwordHash);
  if (!match) throw new Error('Email ou senha incorretos');

  const token = jwt.sign(
    { userId: user.id, email: user.email, role: user.role },
    JWT_SECRET,
    { expiresIn: '7d' },
  );

  return { token, user: { id: user.id, email: user.email, role: user.role } };
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

function getUserById(userId) {
  const users = loadUsers();
  const user = users.find(u => u.id === userId);
  if (!user) return null;
  const { passwordHash: _, ...safe } = user;
  return safe;
}

// ─── Instance Ownership ───

function assignInstance(instanceId, userId, password) {
  const mapping = loadInstances();
  // Support old format (string userId) and new format (object)
  mapping[instanceId] = { userId, password: password || null };
  saveInstances(mapping);
}

function removeInstance(instanceId) {
  const mapping = loadInstances();
  delete mapping[instanceId];
  saveInstances(mapping);
}

function _getEntry(instanceId) {
  const mapping = loadInstances();
  const entry = mapping[instanceId];
  if (!entry) return null;
  // Backward compat: old format was just a userId string
  if (typeof entry === 'string') return { userId: entry, password: null };
  return entry;
}

function getInstanceOwner(instanceId) {
  const entry = _getEntry(instanceId);
  return entry ? entry.userId : null;
}

function getInstancePassword(instanceId) {
  const entry = _getEntry(instanceId);
  return entry ? entry.password : null;
}

function getUserInstanceIds(userId) {
  const mapping = loadInstances();
  return Object.keys(mapping).filter(id => {
    const entry = mapping[id];
    if (typeof entry === 'string') return entry === userId;
    return entry && entry.userId === userId;
  });
}

module.exports = {
  ensureDataDir,
  registerUser,
  loginUser,
  verifyToken,
  getUserById,
  assignInstance,
  removeInstance,
  getInstanceOwner,
  getInstancePassword,
  getUserInstanceIds,
};
