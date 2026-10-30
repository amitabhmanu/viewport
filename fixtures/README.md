# Fixtures

Small sample apps used to test model bootstrapping, verification and the import scanner. They are not part of the workspace build or lint.

## py-shop (Python, primary target)

Expected components, one per package under `src/shop/`:

| Component | Paths | Depends on |
| --- | --- | --- |
| API | `src/shop/api/**` | Orders |
| Orders | `src/shop/orders/**` | Payments, Notifications, Storage |
| Payments | `src/shop/payments/**` | (external payment provider) |
| Notifications | `src/shop/notifications/**` | none |
| Storage | `src/shop/storage/**` | Orders (models) |

Exercises absolute imports (`from shop.x import y`), relative imports (`from .models import Order`), and a dependency cycle (Orders and Storage).

## ts-notes (TypeScript, second target)

| Component | Paths | Depends on |
| --- | --- | --- |
| Server | `src/server/**` | Auth, Notes |
| Auth | `src/auth/**` | Storage |
| Notes | `src/notes/**` | Storage |
| Storage | `src/storage/**` | none |

Exercises relative ESM imports, a tsconfig path alias (`@storage/*`), and a CommonJS `require`.
