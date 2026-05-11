import { initializeApp } from 'firebase/app';
import {
  getFirestore, doc, getDoc, setDoc, onSnapshot
} from 'firebase/firestore';

// Firebase config — these keys are public by design.
// Security is enforced by Firestore security rules, not by hiding the keys.
const firebaseConfig = {
  apiKey: "AIzaSyCgcyvnmd5yyTgtyz_MU9TYXOZAyA5C_0k",
  authDomain: "majors-picks.firebaseapp.com",
  projectId: "majors-picks",
  storageBucket: "majors-picks.firebasestorage.app",
  messagingSenderId: "912963323414",
  appId: "1:912963323414:web:96aadf8d20615973569737"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// All app data lives in a single collection, one document per key
// (config, field, entries) — each document has a single `value` field.
const COLLECTION = 'majors_picks';

export const storageGet = async (key, fallback) => {
  try {
    const snap = await getDoc(doc(db, COLLECTION, key));
    return snap.exists() ? snap.data().value : fallback;
  } catch (e) {
    console.error('Firestore get error:', e);
    return fallback;
  }
};

export const storageSet = async (key, value) => {
  try {
    await setDoc(doc(db, COLLECTION, key), {
      value,
      updatedAt: new Date().toISOString()
    });
  } catch (e) {
    console.error('Firestore set error:', e);
  }
};

// Real-time subscription — callback fires whenever the document changes,
// including on initial load (with the current value or null if not yet set).
// Returns an unsubscribe function.
export const storageSubscribe = (key, callback) => {
  return onSnapshot(
    doc(db, COLLECTION, key),
    (snap) => {
      callback(snap.exists() ? snap.data().value : null);
    },
    (err) => {
      console.error('Firestore subscribe error:', err);
    }
  );
};
