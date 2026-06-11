// Firestore persistence used by the browser application.
const firebaseConfig = {
  apiKey: "AIzaSyC8Debbv3hvkedn15E98gSfiUSH2955ouA",
  authDomain: "criptoshishastpv.firebaseapp.com",
  projectId: "criptoshishastpv",
  storageBucket: "criptoshishastpv.firebasestorage.app",
  messagingSenderId: "963607058818",
  appId: "1:963607058818:web:b8f09049bf4554ee92179b",
  measurementId: "G-KC1WSD664M",
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

class FirebaseService {
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

  static async saveDocument(collectionName, id, data) {
    await db.collection(collectionName).doc(id).set(data);
    return { success: true, id };
  }

  static async deleteDocument(collectionName, id) {
    await db.collection(collectionName).doc(id).delete();
    return { success: true };
  }

  static async getCollection(collectionName) {
    const snapshot = await db.collection(collectionName).get();
    return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  }

  static onCollectionChanged(collectionName, callback, onError) {
    return db.collection(collectionName).onSnapshot(
      (snapshot) => {
        callback(snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })));
      },
      onError,
    );
  }

  static saveUser(userId, userData) {
    return this.saveDocument("users", userId, userData);
  }

  static getAllUsers() {
    return this.getCollection("users");
  }

  static deleteUser(userId) {
    return this.deleteDocument("users", userId);
  }

  static onUsersChanged(callback, onError) {
    return this.onCollectionChanged("users", callback, onError);
  }

  static saveOrder(orderId, orderData) {
    return this.saveDocument("orders", orderId, orderData);
  }

  static getAllOrders() {
    return this.getCollection("orders");
  }

  static deleteOrder(orderId) {
    return this.deleteDocument("orders", orderId);
  }

  static onOrdersChanged(callback, onError) {
    return this.onCollectionChanged("orders", callback, onError);
  }

  static saveTimeEntry(entryId, entryData) {
    return this.saveDocument("timeEntries", entryId, entryData);
  }

  static getAllTimeEntries() {
    return this.getCollection("timeEntries");
  }

  static deleteTimeEntry(entryId) {
    return this.deleteDocument("timeEntries", entryId);
  }

  static onTimeEntriesChanged(callback, onError) {
    return this.onCollectionChanged("timeEntries", callback, onError);
  }

  static async deleteAllOrders() {
    const snapshot = await db.collection("orders").get();
    if (snapshot.empty) return { success: true };

    const batches = [];
    let batch = db.batch();
    let operationCount = 0;

    snapshot.docs.forEach((doc) => {
      batch.delete(doc.ref);
      operationCount += 1;
      if (operationCount === 450) {
        batches.push(batch.commit());
        batch = db.batch();
        operationCount = 0;
      }
    });

    if (operationCount > 0) batches.push(batch.commit());
    await Promise.all(batches);
    return { success: true };
  }

  static async saveConfig(configName, configData) {
    await db.collection("config").doc(configName).set(configData, { merge: true });
    return { success: true };
  }

  static async getConfig(configName) {
    const doc = await db.collection("config").doc(configName).get();
    return doc.exists ? doc.data() : null;
  }

  static onConfigChanged(configName, callback, onError) {
    return db.collection("config").doc(configName).onSnapshot(
      (doc) => callback(doc.exists ? doc.data() : null),
      onError,
    );
  }
}

window.FirebaseService = FirebaseService;
