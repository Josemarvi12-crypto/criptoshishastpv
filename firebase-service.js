// Firebase Service - Maneja toda la lógica de Firestore y Authentication

const firebaseConfig = {
  apiKey: "AIzaSyC8Debbv3hvkedn15E98gSfiUSH2955ouA",
  authDomain: "criptoshishastpv.firebaseapp.com",
  projectId: "criptoshishastpv",
  storageBucket: "criptoshishastpv.firebasestorage.app",
  messagingSenderId: "963607058818",
  appId: "1:963607058818:web:b8f09049bf4554ee92179b",
  measurementId: "G-KC1WSD664M"
};

// Inicializar Firebase
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

class FirebaseService {
  // ===== AUTENTICACIÓN =====
  
  static async loginWithEmail(email, password) {
    try {
      const result = await auth.signInWithEmailAndPassword(email, password);
      return { success: true, user: result.user };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  static async logout() {
    try {
      await auth.signOut();
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  static getCurrentUser() {
    return auth.currentUser;
  }

  static onAuthStateChanged(callback) {
    return auth.onAuthStateChanged(callback);
  }

  // ===== USUARIOS =====
  
  static async saveUser(userId, userData) {
    try {
      await db.collection('users').doc(userId).set(userData, { merge: true });
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  static async getUser(userId) {
    try {
      const doc = await db.collection('users').doc(userId).get();
      return doc.exists ? doc.data() : null;
    } catch (error) {
      console.error('Error al obtener usuario:', error);
      return null;
    }
  }

  static async getAllUsers() {
    try {
      const snapshot = await db.collection('users').get();
      return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    } catch (error) {
      console.error('Error al obtener usuarios:', error);
      return [];
    }
  }

  // ===== ÓRDENES =====
  
  static async saveOrder(orderId, orderData) {
    try {
      await db.collection('orders').doc(orderId).set(orderData);
      return { success: true, id: orderId };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  static async getOrder(orderId) {
    try {
      const doc = await db.collection('orders').doc(orderId).get();
      return doc.exists ? doc.data() : null;
    } catch (error) {
      console.error('Error al obtener orden:', error);
      return null;
    }
  }

  static async getAllOrders() {
    try {
      const snapshot = await db.collection('orders').get();
      return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    } catch (error) {
      console.error('Error al obtener órdenes:', error);
      return [];
    }
  }

  static async getOrdersByDate(date) {
    try {
      const startOfDay = new Date(date);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(date);
      endOfDay.setHours(23, 59, 59, 999);

      const snapshot = await db.collection('orders')
        .where('createdAt', '>=', startOfDay)
        .where('createdAt', '<=', endOfDay)
        .get();

      return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    } catch (error) {
      console.error('Error al obtener órdenes por fecha:', error);
      return [];
    }
  }

  // ===== CONFIGURACIÓN =====
  
  static async saveConfig(configName, configData) {
    try {
      await db.collection('config').doc(configName).set(configData, { merge: true });
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  static async getConfig(configName) {
    try {
      const doc = await db.collection('config').doc(configName).get();
      return doc.exists ? doc.data() : null;
    } catch (error) {
      console.error('Error al obtener configuración:', error);
      return null;
    }
  }

  // ===== ESCUCHAS EN TIEMPO REAL =====
  
  static onOrdersChanged(callback) {
    return db.collection('orders').onSnapshot(snapshot => {
      const orders = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      callback(orders);
    });
  }

  static onUsersChanged(callback) {
    return db.collection('users').onSnapshot(snapshot => {
      const users = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      callback(users);
    });
  }

  // ===== SINCRONIZACIÓN CON LOCALSTORAGE =====
  
  static async syncLocalStorageToFirestore(localStorageKey, firestoreCollection) {
    try {
      const localData = JSON.parse(localStorage.getItem(localStorageKey) || '{}');
      
      if (Object.keys(localData).length > 0) {
        // Subir datos locales a Firestore
        for (const [key, value] of Object.entries(localData)) {
          await db.collection(firestoreCollection).doc(key).set(value, { merge: true });
        }
        return { success: true, itemsSynced: Object.keys(localData).length };
      }
      return { success: true, itemsSynced: 0 };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
}

// Exportar para uso en navegador
window.FirebaseService = FirebaseService;
