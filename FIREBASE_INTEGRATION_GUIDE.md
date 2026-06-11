# Firebase: configuración de producción

## Estado actual

Configurado el 12 de junio de 2026:

- Cloud Firestore en la región europea `eur3`.
- Edición Standard gratuita y protección contra borrado activada.
- Firebase Authentication con correo y contraseña.
- Inicio de sesión mediante un único código para cada trabajador.
- Perfiles vinculados al `uid` de Firebase.
- Reglas que bloquean cualquier acceso sin una cuenta activa.
- Sincronización en tiempo real de pedidos, usuarios, fichajes y configuración.
- Caché local para tolerar cortes temporales de conexión.

## Usuarios iniciales

- Gerente: código entregado al propietario.
- Vendedor: código entregado al propietario.

Los códigos son contraseñas privadas. No se guardan en Firestore ni se incluyen en el
código fuente publicado.

## Colecciones

- `users/{uid}`: nombre, rol, estado y fecha de creación.
- `orders/{orderId}`: pedidos.
- `timeEntries/{entryId}`: fichajes.
- `config/app-state`: centros, catálogo, stock y ajustes.

## Gestión de usuarios

Un gerente puede crear trabajadores desde Ajustes. La aplicación genera el código,
crea la cuenta de Firebase y muestra el código una sola vez. Si se desactiva o elimina
el perfil, esa cuenta deja de tener acceso a los datos aunque conserve sus credenciales.

## Verificaciones realizadas

- Login real de gerente.
- Login real de vendedor con navegación restringida.
- Lectura y escritura protegidas por reglas.
- Pedido temporal recibido y eliminado en tiempo real entre dos sesiones.
- Acceso anónimo rechazado.

Como mejora futura, la creación y eliminación definitiva de cuentas puede moverse a
una función administrativa de servidor. El acceso actual a los datos ya exige un
perfil activo creado por un gerente.
