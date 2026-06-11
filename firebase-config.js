// Firebase Configuration
const firebaseConfig = {
  apiKey: "AIzaSyC8Debbv3hvkedn15E98gSfiUSH2955ouA",
  authDomain: "criptoshishastpv.firebaseapp.com",
  projectId: "criptoshishastpv",
  storageBucket: "criptoshishastpv.firebasestorage.app",
  messagingSenderId: "963607058818",
  appId: "1:963607058818:web:b8f09049bf4554ee92179b",
  measurementId: "G-KC1WSD664M"
};

// Initialize Firebase
import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getDatabase } from "firebase/database";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const realtimeDb = getDatabase(app);

export { app, auth, db, realtimeDb };
