# 📖 Guía de Integración de Firebase

## Cambios necesarios en app.js

Tu aplicación actual usa `localStorage` para guardar datos. Para sincronizar con Firebase, necesitas hacer estos cambios:

### 1. Reemplazar `loadState()` (localStorage)

**ANTES:**
```javascript
function loadState() {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored ? JSON.parse(stored) : { ...defaults };
}
```

**AHORA:**
```javascript
async function loadState() {
  // Cargar desde Firestore
  const users = await FirebaseService.getAllUsers();
  const orders = await FirebaseService.getAllOrders();
  
  if (users.length > 0 || orders.length > 0) {
    // Si hay datos en Firestore, usarlos
    return {
      ...defaults,
      users: users,
      orders: orders
    };
  }
  
  // Si no hay datos, usar defaults
  return { ...defaults };
}
```

### 2. Reemplazar `saveState()` (localStorage)

**ANTES:**
```javascript
function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}
```

**AHORA:**
```javascript
async function saveState() {
  // Guardar en Firestore
  for (const user of state.users) {
    await FirebaseService.saveUser(user.id, user);
  }
  for (const order of state.orders) {
    await FirebaseService.saveOrder(order.id, order);
  }
  // También guardar en localStorage como caché local
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}
```

### 3. Cambiar el login para usar Firebase Auth

**IMPORTANTE:** Primero debes crear usuarios en Firebase:

1. Ve a https://console.firebase.google.com
2. Selecciona tu proyecto `criptoshishastpv`
3. Ve a **Authentication** → **Users**
4. Crea estos usuarios con email/contraseña:
   - **Email:** manager@demo.com | **Contraseña:** manager123
   - **Email:** vendedor@demo.com | **Contraseña:** vendedor123

### 4. Actualizar el formulario de login

**Actualmente tu app usa un código (Gerente1234), cambia a:**

```javascript
const loginForm = document.querySelector("#loginForm");
const emailInput = document.querySelector("#loginEmail"); // Cambia el input a email
const passwordInput = document.querySelector("#loginPassword"); // Usa para password

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  
  const email = emailInput.value;
  const password = passwordInput.value;
  
  const result = await FirebaseService.loginWithEmail(email, password);
  
  if (result.success) {
    // Login exitoso
    currentUser = result.user;
    showAppShell();
  } else {
    // Mostrar error
    document.querySelector("#loginError").textContent = result.error;
  }
});
```

### 5. Sincronización en tiempo real (OPCIONAL pero RECOMENDADO)

Para que los datos se actualicen instantáneamente en todos los navegadores:

```javascript
// Al iniciar la app, suscribirse a cambios
FirebaseService.onOrdersChanged((orders) => {
  state.orders = orders;
  // Volver a renderizar la UI
  renderOrders();
});

FirebaseService.onUsersChanged((users) => {
  state.users = users;
  // Volver a renderizar usuarios
  renderUsers();
});
```

## Pasos rápidos de implementación:

1. **Crear usuarios en Firebase** (ver paso 4 arriba)
2. **Copiar la función loadState() actualizada**
3. **Copiar la función saveState() actualizada**
4. **Actualizar el login form HTML** (cambiar de código a email/password)
5. **Actualizar el event listener del login**
6. **Agregar listeners en tiempo real** (opcional)

## Probar la app:

```bash
node servidor.js
# Luego ve a http://localhost:5000
```

Inicia sesión con:
- **Email:** manager@demo.com
- **Contraseña:** manager123

## Preguntas frecuentes:

**P: ¿Se perderán los datos?**
A: No, si hay datos en localStorage, puedes migrarlos a Firestore con `FirebaseService.syncLocalStorageToFirestore()`

**P: ¿Funciona sin internet?**
A: Sí, localStorage servirá como caché. Firestore sincronizará cuando haya conexión.

**P: ¿Es seguro compartir las credenciales de Firebase?**
A: Sí, las de la web (apiKey, authDomain, etc.) son públicas. Las que NO debes compartir son las de admin.

---

¿Necesitas ayuda implementando estos cambios?
