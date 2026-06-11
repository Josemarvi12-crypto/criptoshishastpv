# Firebase: estado y puesta en producción

## Estado actual

La aplicación ya incluye:

- SDK Firebase Compat 10.7.0 cargado correctamente.
- Persistencia separada de `orders`, `users`, `timeEntries` y `config`.
- Escuchas `onSnapshot` para actualización en tiempo real.
- Caché local en `localStorage`.
- Migración inicial que mezcla datos locales no subidos con los documentos remotos.
- Borrado remoto de pedidos, usuarios y fichajes.

La sincronización solo se inicia cuando existe una sesión válida de Firebase Auth.

## Bloqueo detectado el 11 de junio de 2026

- Firestore rechaza las peticiones sin autenticar con HTTP 403.
- La cuenta de ejemplo `manager@demo.com` documentada anteriormente no inicia sesión.
- El login por código de la interfaz es un control local y no equivale a Firebase Auth.

No abras Firestore con reglas `allow read, write: if true`. Eso expondría pedidos,
usuarios, códigos de acceso y fichajes.

## Configuración necesaria

1. Activa un proveedor en Firebase Authentication.
2. Crea cuentas reales para las personas que usarán el TPV.
3. Sustituye el login local por Firebase Auth y vincula cada perfil con `auth.uid`.
4. Publica reglas de Firestore que comprueben `request.auth.uid` y el rol del perfil.
5. Elimina los usuarios y códigos de demostración de `defaults` después de migrar los
   datos existentes.
6. Prueba con dos navegadores: crear, cobrar, editar y borrar un pedido; abrir y cerrar
   un fichaje; modificar stock; perder y recuperar la conexión.

## Modelo recomendado

- `users/{uid}`: nombre, rol, activo y centros permitidos. Nunca contraseñas.
- `orders/{orderId}`: pedido completo y `createdByUid`.
- `timeEntries/{entryId}`: fichaje y `userId`.
- `config/app-state`: centros, catálogo y ajustes no sensibles.

La creación de usuarios y la asignación del rol de gerente deben hacerse con Firebase
Admin SDK en una función o API protegida, no desde JavaScript público del navegador.
