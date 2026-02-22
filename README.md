# Bot de compra y envío (Proton)

Guía mínima para dejarlo corriendo en VPS 24/7 con el menor trabajo posible.

## 1) Qué hace
- A la hora `compraUtc`, revisa el mercado y decide compras usando reglas de caída.
- Reparte el monto diario entre `XPR_XMD`, `LOAN_XMD`, `METAL_XMD` y `XMT_XMD` según `asignacionesMercado`.
- Si un `asignacionesMercado` tiene `0%`, no compra ese token.
- Si hay caída extrema (según `reglaCaidaExtrema`), prioriza esa condición.
- Si no hay extrema, aplica la regla progresiva (`reglaCaidaProgresiva`) cuando corresponda.
- Respeta `bloqueoCompraUltimosDias` para detener compras al final del mes por mercado.
- A la hora `envioUtc`, envía solo los tokens que sí compró ese mismo día a `TO_ACCOUNT`.
- Propina: envía un porcentaje del monto final a la cuenta del creador para apoyar el proyecto (`propina.activa`, por defecto en `false`).

## 2) Preparar VPS (Ubuntu)

Instala dependencias y descarga el proyecto:

```bash
sudo apt update -y && sudo apt install -y git curl
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm i -g pm2
git clone https://github.com/networkxpr-max/nada.git
cd nada
npm install
cp .env.example .env
```

## 3) Editar ANTES del deploy

### `.env`
- `PRIVATE_KEY`
- `BOT_USERNAME`
- `TO_ACCOUNT`

### `config.json`
- `compraUtc` y `envioUtc`
- `asignacionesMercado` (máximo total 100%)
	- `XPR_XMD`: porcentaje para comprar XPR
	- `LOAN_XMD`: porcentaje para comprar LOAN
	- `METAL_XMD`: porcentaje para comprar METAL
	- `XMT_XMD`: porcentaje para comprar XMT
	- si pones `0%` en uno, ese token no se compra
- `propina` (opcional: por defecto false, puedes activar y cambiar el %)
- `reglasCompra`
- `bloqueoCompraUltimosDias` (0 = compra todo el mes)

Comandos para editar:

```bash
nano .env
```

```bash
nano config.json
```

## 4) Deploy (recién después de editar)

Ahora sí lo dejas corriendo 24/7:

```bash
pm2 start index.js --name bot-proton
pm2 save
pm2 startup
```

## 5) Comandos útiles

```bash
pm2 status
pm2 logs bot-proton
pm2 restart bot-proton
pm2 stop bot-proton
```

## 7) Estrategia de trading (paso a paso, valores por defecto)

Con la configuración actual de `config.json`, el bot trabaja así:

### Base del cálculo diario

Si **NO** se activa la regla extrema, el bot calcula primero:

`monto_diario = balance_XMD / días_restantes_del_mes`

Luego reparte ese `monto_diario` por `asignacionesMercado`.

> Ejemplo rápido: balance `30 XMD` y faltan `10` días del mes -> `monto_diario = 3 XMD`.

1. **Hora de compra: 00:00 UTC**
	- Lee balance de XMD.
	- Lee caídas diarias de: `XPR_XMD`, `LOAN_XMD`, `METAL_XMD`, `XMT_XMD`.

2. **Filtro por asignación**
	- Solo considera mercados con asignación > 0.
	- Por defecto: 25% cada uno (total 100%).

3. **Regla extrema primero** (`porcentajeActivacion = -50`)
	- Si uno o más símbolos están en `<= -50%`:
	  - usa casi todo el balance (reserva 1 XMD),
	  - reparte ese monto entre los símbolos en caída extrema,
	  - ejecuta compras y termina el ciclo.

4. **Si no hay extrema, aplica regla normal**
	- Toma símbolos en rojo (`< 0%`).
	- Calcula monto diario: `balance / días restantes del mes`.
	- Reparte por asignación (25/25/25/25 por defecto).

5. **Multiplicador progresivo**
	- Se activa desde `-5%`.
	- Parámetros por defecto:
	  - `pasoPorcentaje = 5`
	  - `multiplicadorPorPaso = 2`
	- Ejemplo: `-5% => x2`, `-10% => x4`, `-15% => x6`.
	- No aplica en los últimos 10 días del mes (`aplicarEnUltimosDiasMes = false`, `diasFinalMes = 10`).

6. **Bloqueo por fin de mes**
	- `bloqueoCompraUltimosDias` está en `0` para todos.
	- Significa que compra todo el mes (sin bloqueo adicional).

7. **Ejecución de orden**
	- El bot evalúa si conviene 1 orden grande o varias pequeñas.
	- Espera 3000 ms entre orden y revisión.
	- Reintenta hasta 3 veces por mercado.

8. **Hora de envío: 00:05 UTC**
	- Envía solo símbolos que sí compró ese mismo día.
	- Envía todo a `TO_ACCOUNT`.





