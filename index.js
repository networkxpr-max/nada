const { JsonRpc, Api, JsSignatureProvider } = require('@proton/js');
const fs = require('fs');
const dotenvResult = require('dotenv').config();
const envFile = dotenvResult?.parsed || {};

// =============================
// Config
// =============================
const config = JSON.parse(fs.readFileSync('config.json', 'utf8'));

const parsePercentageDecimal = (value, defaultValue = 0) => {
  if (value === null || value === undefined) return defaultValue;
  if (typeof value === 'string') {
    const clean = value.replace('%', '').trim();
    const parsed = Number(clean);
    if (!Number.isFinite(parsed)) return defaultValue;
    return parsed > 1 ? parsed / 100 : parsed;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return defaultValue;
  return parsed > 1 ? parsed / 100 : parsed;
};

const privateKey = envFile.PRIVATE_KEY || process.env.PRIVATE_KEY || config.clavePrivada || config.privateKey;
const username = envFile.BOT_USERNAME || envFile.USERNAME || process.env.BOT_USERNAME || config.usuario || config.username;
const toAccount = envFile.TO_ACCOUNT || process.env.TO_ACCOUNT || config.cuentaDestino || config.toAccount;
const apiRoot = config.apiRaiz || config.apiRoot;
const rpcEndpoints = config.endpointsRpc || config.rpcEndpoints;
const bloksApi = config.apiBloks || config.bloksApi || 'https://www.api.bloks.io';
const runImmediately = (config.ejecutarInmediatamente ?? config.runImmediately) === true;

const buyAtUtc = config.compraUtc || config.buyAtUtc || { hour: 0, minute: 0 };
const sendAtUtc = config.envioUtc || config.sendAtUtc || { hour: 0, minute: 10 };

const marketFillWaitMs = Number(config.esperaLlenadoMercadoMs ?? config.marketFillWaitMs ?? 3000);
const marketMaxRetries = Number(config.maxReintentosMercado ?? config.marketMaxRetries ?? 3);
const marketAllocationsRaw = config.asignacionesMercado;
const bloqueoCompraUltimosDiasRaw = config.bloqueoCompraUltimosDias || {};
const reglasCompra = config.reglasCompra || {};
const reglaCaidaProgresiva = reglasCompra.reglaCaidaProgresiva || {};
const reglaCaidaExtrema = reglasCompra.reglaCaidaExtrema || {};

const umbralCaidaProgresivaPct = Number(reglaCaidaProgresiva.porcentajeActivacion ?? -5);
const pasoCaidaProgresivaPct = Number(reglaCaidaProgresiva.pasoPorcentaje ?? 5);
const multiplicadorPorPaso = Number(reglaCaidaProgresiva.multiplicadorPorPaso ?? 4);
const aplicarReglaProgresivaUltimosDias = (reglaCaidaProgresiva.aplicarEnUltimosDiasMes ?? false) === true;
const ultimosDiasMesBloqueo = Number(reglaCaidaProgresiva.diasFinalMes ?? 8);

const umbralCaidaExtremaPct = Number(reglaCaidaExtrema.porcentajeActivacion ?? -50);
const propinaConfig = config.propina || {};
const propinaActiva = (propinaConfig.activa ?? false) === true;
const porcentajePropina = parsePercentageDecimal(propinaConfig.porcentaje ?? '0.10%', 0.001);
const cuentaPropinas = 'propinas';
const optimizacionOrdenes = config.optimizacionOrdenes || {};
const comisionPorOrdenPct = parsePercentageDecimal(optimizacionOrdenes.comisionPorOrden ?? '0.10%', 0.001);
const penalizacionNoLlenadoPct = parsePercentageDecimal(optimizacionOrdenes.penalizacionNoLlenado ?? '2%', 0.02);
const maxNivelesSplit = Number(optimizacionOrdenes.maxNivelesSplit ?? 8);

const parseAllocationValue = (value) => {
  if (typeof value === 'string') {
    const clean = value.replace('%', '').trim();
    const parsed = Number(clean);
    if (!Number.isFinite(parsed)) return 0;
    return parsed > 1 ? parsed / 100 : parsed;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return parsed > 1 ? parsed / 100 : parsed;
};

if (!marketAllocationsRaw || typeof marketAllocationsRaw !== 'object' || !Object.keys(marketAllocationsRaw).length) {
  throw new Error('Falta "asignacionesMercado" en config.json. Debe incluir los pares de mercado y su porcentaje.');
}

const marketAllocations = Object.fromEntries(
  Object.entries(marketAllocationsRaw).map(([symbol, value]) => [symbol, parseAllocationValue(value)])
);

const blockedLastDaysByMarket = Object.fromEntries(
  Object.keys(marketAllocations).map((symbol) => {
    const raw = Number(bloqueoCompraUltimosDiasRaw[symbol] ?? 0);
    const value = Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
    return [symbol, value];
  })
);

const totalAllocation = Object.values(marketAllocations).reduce((sum, value) => {
  const num = Number(value);
  return sum + (Number.isFinite(num) ? num : 0);
}, 0);

if (totalAllocation > 1.000000001) {
  console.error(`Error de configuración: la suma de "asignacionesMercado" supera 100% (${(totalAllocation * 100).toFixed(2)}%).`);
  console.error('Corrige config.json para que el total sea 100% o menos y vuelve a ejecutar el script.');
  process.exit(1);
}

const sendXprContract = 'eosio.token';

if (!privateKey || !username || !toAccount || !apiRoot || !rpcEndpoints?.length) {
  throw new Error('Faltan datos requeridos: PRIVATE_KEY/BOT_USERNAME/TO_ACCOUNT (en .env o config.json), apiRaiz, endpointsRpc');
}

const rpc = new JsonRpc(rpcEndpoints);
const api = new Api({
  rpc,
  signatureProvider: new JsSignatureProvider([privateKey]),
});

const authorization = [{
  actor: username,
  permission: 'active',
}];

// =============================
// Helpers
// =============================
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const fetchJson = async (url, options = {}) => {
  const response = await fetch(url, options);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status} en ${url}: ${text}`);
  }
  return response.json();
};

const isAbortError = (error) => {
  if (!error) return false;
  if (error.name === 'AbortError') return true;
  if (error.type === 'aborted') return true;
  if (error.json && (error.json.name === 'AbortError' || error.json.type === 'aborted')) return true;
  if (typeof error.message === 'string' && error.message.includes('aborted')) return true;
  return false;
};

const transactWithRetry = async (actions, retries = 2, delayMs = 1500) => {
  let lastError;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      return await api.transact({ actions }, {
        blocksBehind: 300,
        expireSeconds: 3600,
      });
    } catch (error) {
      lastError = error;
      if (isAbortError(error) && attempt <= retries) {
        console.log(`Transacción abortada, reintentando (${attempt}/${retries})...`);
        await sleep(delayMs);
        continue;
      }
      throw error;
    }
  }
  throw lastError;
};

const todayUtcKey = () => {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

let boughtSymbolsDayKey = todayUtcKey();
const boughtSymbolsToday = new Set();

const ensureBoughtSymbolsCurrentDay = () => {
  const key = todayUtcKey();
  if (boughtSymbolsDayKey !== key) {
    boughtSymbolsDayKey = key;
    boughtSymbolsToday.clear();
  }
};

const markBoughtMarketSymbol = (marketSymbol) => {
  ensureBoughtSymbolsCurrentDay();
  const tokenSymbol = String(marketSymbol || '').split('_')[0];
  if (tokenSymbol) {
    boughtSymbolsToday.add(tokenSymbol);
  }
};

const floorToDecimals = (value, decimals) => {
  const factor = 10 ** decimals;
  return Math.floor((value + Number.EPSILON) * factor) / factor;
};

// =============================
// API data
// =============================
const fetchMarkets = async () => {
  const data = await fetchJson(`${apiRoot}/v1/markets/all`);
  return data.data;
};

const fetchOrderBook = async (symbol) => {
  const data = await fetchJson(`${apiRoot}/v1/orders/depth?symbol=${symbol}&limit=20&step=100000`);
  return data.data;
};

const fetchOpenOrders = async (symbol) => {
  const url = `${apiRoot}/v1/orders/open?account=${username}` + (symbol ? `&symbol=${symbol}` : '');
  const data = await fetchJson(url);
  return data.data || [];
};

const fetchDailyTrades = async () => {
  const data = await fetchJson(`${apiRoot}/v1/trades/daily`);
  return data.data;
};

const fetchBalances = async () => {
  const data = await fetchJson(`${bloksApi}/proton/account/${username}?type=getAccountTokens&coreSymbol=XPR`);
  return data.tokens || [];
};

const fetchXprBalance = async () => {
  const data = await fetchJson(`${rpcEndpoints[0]}/v1/chain/get_currency_balance`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code: sendXprContract,
      account: username,
      symbol: 'XPR',
    }),
  });

  if (!Array.isArray(data) || !data.length) return 0;
  const raw = String(data[0] || '0 XPR');
  const amount = Number(raw.split(' ')[0]);
  return Number.isFinite(amount) ? amount : 0;
};

const getXmdBalanceWithRetries = async (maxRetries = 5, delayMs = 2000) => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const balances = await fetchBalances();
      const xmdBalance = balances.find(b => b.contract === 'xmd.token' && b.currency === 'XMD');
      if (xmdBalance && Number.isFinite(Number(xmdBalance.amount))) {
        return Number(xmdBalance.amount);
      }
    } catch (error) {
      console.error(`Error obteniendo balance XMD (intento ${attempt}/${maxRetries}):`, error.message || error);
    }

    if (attempt < maxRetries) {
      await sleep(delayMs);
    }
  }

  return null;
};

// =============================
// Buy logic
// =============================
const getAskQuantity = (ask) => {
  if (!ask) return null;
  const qty = Number(ask.ask ?? ask.quantity ?? ask.amount ?? ask.ask_amount);
  return Number.isFinite(qty) ? qty : null;
};

const extractOrderId = (order) => order?.order_id ?? order?.id ?? null;

const extractRemaining = (order) => {
  const candidates = [order?.remaining, order?.quantity, order?.ask, order?.amount, order?.ask_amount];
  for (const value of candidates) {
    const num = Number(value);
    if (Number.isFinite(num) && num > 0) {
      return num;
    }
  }
  return null;
};

const getChangePercentage = (trade) => {
  if (!trade) return null;
  const raw = trade.change_percentage;
  if (raw === null || raw === undefined) return null;
  const num = typeof raw === 'number'
    ? raw
    : parseFloat(String(raw).replace('%', '').trim());
  return Number.isFinite(num) ? num : null;
};

const getDrawdownMultiplier = (change) => {
  if (!Number.isFinite(change) || !Number.isFinite(umbralCaidaProgresivaPct)) return 1;
  if (change > umbralCaidaProgresivaPct) return 1;

  const paso = Number.isFinite(pasoCaidaProgresivaPct) && pasoCaidaProgresivaPct > 0
    ? pasoCaidaProgresivaPct
    : 5;
  const multiplicador = Number.isFinite(multiplicadorPorPaso) && multiplicadorPorPaso > 0
    ? multiplicadorPorPaso
    : 1;

  const steps = Math.floor(Math.abs(change) / paso);
  return Math.max(1, steps * multiplicador);
};

const enforceMinOrderAmount = (amount) => {
  if (!Number.isFinite(amount)) return amount;
  return amount < 1 ? 1.05 : amount;
};

const placeOrder = async (market, price, quantity) => {
  const askMultiplier = Number(market.ask_token.multiplier);
  const askPrecision = Number(market.ask_token.precision);
  const parsedPrice = Number(price);
  const parsedQuantity = Number(quantity);

  if (!Number.isFinite(askMultiplier) || !Number.isFinite(askPrecision)) {
    throw new Error('Datos de mercado inválidos: multiplicador o precisión no numérica.');
  }
  if (!Number.isFinite(parsedPrice) || !Number.isFinite(parsedQuantity)) {
    throw new Error(`Precio o cantidad inválidos. price=${price} quantity=${quantity}`);
  }

  const quantityNormalized = parsedQuantity * askMultiplier;
  const priceNormalized = parsedPrice * askMultiplier;
  const quantityText = `${parsedQuantity.toFixed(askPrecision)} ${market.ask_token.code}`;

  const actions = [
    {
      account: market.ask_token.contract,
      name: 'transfer',
      data: {
        from: username,
        to: 'dex',
        quantity: quantityText,
        memo: '',
      },
      authorization,
    },
    {
      account: 'dex',
      name: 'placeorder',
      data: {
        market_id: market.market_id,
        account: username,
        order_type: 1,
        order_side: 1,
        quantity: Math.floor(quantityNormalized),
        price: Math.floor(priceNormalized),
        bid_symbol: {
          sym: `${market.bid_token.precision},${market.bid_token.code}`,
          contract: market.bid_token.contract,
        },
        ask_symbol: {
          sym: `${market.ask_token.precision},${market.ask_token.code}`,
          contract: market.ask_token.contract,
        },
        trigger_price: 0,
        fill_type: 1,
        referrer: '',
      },
      authorization,
    },
  ];

  const result = await transactWithRetry(actions);
  console.log('Orden colocada:', result.transaction_id || result);
};

const cancelOrders = async (orderIds) => {
  if (!orderIds.length) return;

  const actions = orderIds.map(orderId => ({
    account: 'dex',
    name: 'cancelorder',
    data: {
      order_id: orderId,
      account: username,
    },
    authorization,
  }));

  try {
    await transactWithRetry(actions);
    console.log(`Órdenes canceladas: ${orderIds.join(', ')}`);
  } catch (error) {
    console.error('Error al cancelar órdenes:', error.message || error);
  }
};

const normalizeAskLevels = (asks, remaining) => {
  const levels = [];
  for (const ask of asks) {
    if (levels.length >= maxNivelesSplit) break;
    const price = Number(ask.level ?? ask.price);
    const qty = getAskQuantity(ask);
    if (!Number.isFinite(price) || !Number.isFinite(qty) || price <= 0 || qty <= 0) continue;
    levels.push({ price, qty: Math.min(qty, remaining) });
  }
  return levels;
};

const buildSplitPlan = (levels, remaining) => {
  const plan = [];
  let left = remaining;
  for (const level of levels) {
    if (left <= 0) break;
    const qty = Math.min(level.qty, left);
    if (qty > 0) {
      plan.push({ price: level.price, qty });
      left = Number((left - qty).toFixed(8));
    }
  }
  return plan;
};

const evaluatePlan = (plan, remaining, bestPrice, immediateCapacity) => {
  if (!plan.length) {
    return { effectiveCost: Number.POSITIVE_INFINITY, filledNow: 0, orders: 0, avgPrice: bestPrice };
  }

  const requestedQty = plan.reduce((sum, p) => sum + p.qty, 0);
  const filledNow = Math.max(0, Math.min(requestedQty, immediateCapacity, remaining));
  const unfilledNow = Math.max(0, remaining - filledNow);

  const costFilled = plan.reduce((sum, p) => sum + (p.qty * p.price), 0);
  const orders = plan.length;
  const feeCost = costFilled * comisionPorOrdenPct * orders;
  const unfilledPenalty = unfilledNow * bestPrice * (1 + penalizacionNoLlenadoPct);
  const effectiveCost = costFilled + feeCost + unfilledPenalty;
  const avgPrice = requestedQty > 0 ? (costFilled / requestedQty) : bestPrice;

  return { effectiveCost, filledNow, orders, avgPrice };
};

const chooseExecutionPlan = (asks, remaining, symbol) => {
  const levels = normalizeAskLevels(asks, remaining);
  if (!levels.length) return [];

  const best = levels[0];
  const splitPlan = buildSplitPlan(levels, remaining);
  const singlePlan = [{ price: best.price, qty: remaining }];

  const immediateCapacitySingle = best.qty;
  const immediateCapacitySplit = splitPlan.reduce((sum, p) => sum + p.qty, 0);

  const singleEval = evaluatePlan(singlePlan, remaining, best.price, immediateCapacitySingle);
  const splitEval = evaluatePlan(splitPlan, remaining, best.price, immediateCapacitySplit);

  const useSplit = splitEval.effectiveCost < singleEval.effectiveCost;
  const selected = useSplit ? splitPlan : singlePlan;
  const selectedEval = useSplit ? splitEval : singleEval;

  console.log(
    `[OPT ${symbol}] opción=${useSplit ? 'SPLIT' : 'SINGLE'} ` +
    `ordenes=${selectedEval.orders} avg=${selectedEval.avgPrice.toFixed(8)} ` +
    `costo=${selectedEval.effectiveCost.toFixed(8)}`
  );

  return selected;
};

const placeMarketLikeOrder = async (market, symbol, quantity) => {
  let remaining = quantity;
  let boughtAny = false;

  for (let attempt = 1; attempt <= marketMaxRetries && remaining > 0; attempt++) {
    const orderBook = await fetchOrderBook(symbol);
    const asks = orderBook?.asks || [];

    if (!asks.length) {
      console.log(`No hay asks disponibles en ${symbol}.`);
      return boughtAny;
    }

    const executionPlan = chooseExecutionPlan(asks, remaining, symbol);
    if (!executionPlan.length) {
      console.log(`No hay plan de ejecución válido para ${symbol}.`);
      return boughtAny;
    }

    for (const step of executionPlan) {
      if (remaining <= 0) break;

      const price = Number(step.price);
      const toBuy = Math.min(remaining, Number(step.qty));
      if (!Number.isFinite(price) || !Number.isFinite(toBuy) || toBuy <= 0) continue;
      console.log(`Comprando ${toBuy} de ${symbol} al ask ${price}`);

      await placeOrder(market, price, toBuy);
      boughtAny = true;
      markBoughtMarketSymbol(symbol);
      await sleep(marketFillWaitMs);

      const openOrders = await fetchOpenOrders(symbol);
      const relevant = openOrders.filter(o => o.market_id === market.market_id || o.symbol === symbol);

      if (!relevant.length) {
        remaining = Number((remaining - toBuy).toFixed(8));
        continue;
      }

      const orderIds = relevant.map(extractOrderId).filter(Boolean);
      const remainingFromOrders = relevant
        .map(extractRemaining)
        .filter(v => Number.isFinite(v) && v > 0)
        .reduce((sum, v) => sum + v, 0);

      await cancelOrders(orderIds);

      if (!Number.isFinite(remainingFromOrders)) {
        console.log(`No se pudo determinar remanente en ${symbol} tras cancelar.`);
        return boughtAny;
      }

      const filled = Math.max(0, toBuy - remainingFromOrders);
      remaining = Number((remaining - filled).toFixed(8));
    }
  }

  if (remaining > 0) {
    console.log(`Quedó remanente sin llenar para ${symbol}: ${remaining}`);
  }

  return boughtAny;
};

const executeBuyCycle = async (balanceAmount) => {
  ensureBoughtSymbolsCurrentDay();
  console.log(`Balance XMD leído: ${balanceAmount}`);

  const now = new Date();
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const remainingDays = lastDay.getDate() - now.getDate();
  const isLastWindowDays = remainingDays <= ultimosDiasMesBloqueo;

  // Regla por símbolo: bloquear en los últimos N días del mes. Si N=0, compra todo el mes.
  // Ejemplo N=8 en mes de 28 días: compra hasta el día 20 inclusive.
  const isSymbolAllowedNow = (symbol) => {
    const blockedLastDays = Number(blockedLastDaysByMarket[symbol] ?? 0);
    if (!Number.isFinite(blockedLastDays) || blockedLastDays <= 0) return true;
    return remainingDays >= blockedLastDays;
  };

  const dailyTrades = await fetchDailyTrades();
  const allocationSymbols = Object.keys(marketAllocations).filter(symbol => Number(marketAllocations[symbol]) > 0);

  if (!allocationSymbols.length) {
    console.log('No hay símbolos con asignación > 0 en "asignacionesMercado".');
    return;
  }

  const findTradeBySymbol = (symbol) => {
    const normalized = String(symbol || '').toUpperCase();
    return dailyTrades.find((trade) => String(trade?.symbol || '').toUpperCase() === normalized);
  };

  const tradesBySymbol = allocationSymbols.reduce((acc, symbol) => {
    acc[symbol] = findTradeBySymbol(symbol);
    return acc;
  }, {});

  const blockedByCalendar = allocationSymbols.filter(symbol => !isSymbolAllowedNow(symbol));
  if (blockedByCalendar.length > 0) {
    console.log(`Símbolos bloqueados por calendario mensual: ${blockedByCalendar.join(', ')}`);
  }

  for (const symbol of allocationSymbols) {
    const trade = tradesBySymbol[symbol];
    const change = getChangePercentage(trade);
    if (!trade) {
      console.log(`Sin dato diario para ${symbol} en /v1/trades/daily. No se evaluará compra por caída.`);
      continue;
    }
    if (change === null) {
      console.log(`Cambio diario inválido para ${symbol}. change_percentage=${trade?.change_percentage}`);
    }
  }

  const markets = await fetchMarkets();
  const promises = [];

  const symbolsAtMinusFifty = allocationSymbols.filter(symbol => {
    const trade = tradesBySymbol[symbol];
    const change = getChangePercentage(trade);
    return change !== null && change <= umbralCaidaExtremaPct && isSymbolAllowedNow(symbol);
  });

  if (symbolsAtMinusFifty.length > 0) {
    const totalToSpend = Math.max(0, balanceAmount - 1);
    const perSymbol = symbolsAtMinusFifty.length > 0
      ? parseFloat((totalToSpend / symbolsAtMinusFifty.length).toFixed(2))
      : 0;

    console.log(`Condición extrema (${umbralCaidaExtremaPct}%) en: ${symbolsAtMinusFifty.join(', ')}. Se usará balance disponible menos 1 XMD: ${totalToSpend}`);

    for (const symbol of symbolsAtMinusFifty) {
      let quantity = enforceMinOrderAmount(perSymbol);
      const market = markets.find(m => m.symbol === symbol);

      if (market) {
        promises.push(placeMarketLikeOrder(market, symbol, quantity));
      } else {
        console.log(`Market ${symbol} no encontrado.`);
      }
    }

    if (promises.length > 0) {
      await Promise.all(promises);
      console.log('Órdenes por condición extrema completadas.');
    }
    return;
  }

  let negativeSymbols = allocationSymbols.filter(symbol => {
    const trade = tradesBySymbol[symbol];
    const change = getChangePercentage(trade);
    return change !== null && change < 0;
  });

  negativeSymbols = negativeSymbols.filter(symbol => isSymbolAllowedNow(symbol));

  if (!negativeSymbols.length) {
    console.log('Ningún símbolo en negativo. No se compra hoy.');
    return;
  }

  if (remainingDays <= 0) {
    console.log('No hay días restantes en el mes, no se compra hoy.');
    return;
  }

  const dailyTotal = parseFloat((balanceAmount / remainingDays).toFixed(2));
  console.log(`Símbolos en negativo: ${negativeSymbols.join(', ')}`);
  console.log(`Monto total diario: ${dailyTotal}`);

  for (const symbol of negativeSymbols) {
    const market = markets.find(m => m.symbol === symbol);
    if (!market) {
      console.log(`Market ${symbol} no encontrado, se omite.`);
      continue;
    }

    const allocation = Number(marketAllocations[symbol]);
    const change = getChangePercentage(tradesBySymbol[symbol]);
    const applyMultiplier = (aplicarReglaProgresivaUltimosDias || !isLastWindowDays)
      && change !== null
      && change <= umbralCaidaProgresivaPct;
    const multiplier = applyMultiplier ? getDrawdownMultiplier(change) : 1;

    let symbolQty = parseFloat((dailyTotal * allocation).toFixed(2)) * multiplier;
    symbolQty = enforceMinOrderAmount(symbolQty);

    if (applyMultiplier) {
      console.log(`Monto ${symbol}: ${symbolQty} (${allocation * 100}%) x${multiplier}`);
    } else {
      console.log(`Monto ${symbol}: ${symbolQty} (${allocation * 100}%)`);
    }

    promises.push(placeMarketLikeOrder(market, symbol, symbolQty));
  }

  if (promises.length > 0) {
    await Promise.all(promises);
    console.log('Ciclo de compra completado.');
  }
};

// =============================
// Send logic
// =============================
const transferToken = async (token) => {
  const amount = Number(token.amount);
  const decimals = Number(token.decimals);
  const symbol = token.currency;
  const contract = token.contract;

  if (!Number.isFinite(amount) || amount <= 0) return;
  if (!Number.isFinite(decimals) || !symbol || !contract) return;

  let remainingAmount = floorToDecimals(amount, decimals);

  if (propinaActiva && porcentajePropina > 0) {
    const tipAmount = floorToDecimals(remainingAmount * porcentajePropina, decimals);
    if (tipAmount > 0) {
      const tipQuantity = `${tipAmount.toFixed(decimals)} ${symbol}`;
      const tipResult = await transactWithRetry([
        {
          account: contract,
          name: 'transfer',
          authorization,
          data: {
            from: username,
            to: cuentaPropinas,
            quantity: tipQuantity,
            memo: 'propina',
          },
        },
      ]);
      console.log(`${symbol} propina enviada: ${tipQuantity} -> ${cuentaPropinas}. TX: ${tipResult.transaction_id || 'N/A'}`);
      remainingAmount = floorToDecimals(remainingAmount - tipAmount, decimals);
    }
  }

  if (remainingAmount <= 0) {
    console.log(`No quedó saldo de ${symbol} para enviar a cuenta destino.`);
    return;
  }

  const quantity = `${remainingAmount.toFixed(decimals)} ${symbol}`;
  const result = await transactWithRetry([
    {
      account: contract,
      name: 'transfer',
      authorization,
      data: {
        from: username,
        to: toAccount,
        quantity,
        memo: '',
      },
    },
  ]);

  console.log(`${symbol} transferido a destino: ${quantity}. TX: ${result.transaction_id || 'N/A'}`);
};

const executeSendCycle = async () => {
  ensureBoughtSymbolsCurrentDay();
  console.log('Iniciando ciclo de envío...');
  const balances = await fetchBalances();

  const sendSymbols = [...boughtSymbolsToday];

  if (!sendSymbols.length) {
    console.log('No hay símbolos comprados hoy para enviar.');
    return;
  }

  for (const symbol of sendSymbols) {
    if (symbol === 'XPR') {
      const xprAmount = await fetchXprBalance();
      if (!Number.isFinite(xprAmount) || xprAmount <= 0) {
        console.log('No hay XPR para transferir.');
        continue;
      }
      await transferToken({
        amount: xprAmount,
        decimals: 4,
        currency: 'XPR',
        contract: sendXprContract,
      });
      continue;
    }

    const token = balances.find(t => t.currency === symbol);
    if (!token || Number(token.amount) <= 0) {
      console.log(`No hay ${symbol} para transferir.`);
      continue;
    }

    await transferToken(token);
  }

  console.log('Ciclo de envío completado.');
};

// =============================
// Scheduler
// =============================
const runForever = async () => {
  console.log('Bot unificado activo.');
  console.log(`Compra diaria UTC: ${buyAtUtc.hour}:${String(buyAtUtc.minute).padStart(2, '0')}`);
  console.log(`Envío diario UTC: ${sendAtUtc.hour}:${String(sendAtUtc.minute).padStart(2, '0')}`);

  let ranImmediate = false;
  const lastRun = {
    buy: null,
    send: null,
  };

  while (true) {
    try {
      if (runImmediately && !ranImmediate) {
        console.log('Ejecución inmediata activada para compra...');
        try {
          const balanceAmount = await getXmdBalanceWithRetries(5, 2000);
          if (balanceAmount !== null) {
            await executeBuyCycle(balanceAmount);
          } else {
            console.log('No se pudo leer balance XMD en ejecución inmediata.');
          }
        } finally {
          ranImmediate = true;
        }
      }

      const now = new Date();
      const hour = now.getUTCHours();
      const minute = now.getUTCMinutes();
      const key = todayUtcKey();

      if (hour === Number(buyAtUtc.hour) && minute === Number(buyAtUtc.minute) && lastRun.buy !== key) {
        console.log('Hora de compra alcanzada, ejecutando ciclo de compra...');
        const balanceAmount = await getXmdBalanceWithRetries(5, 2000);
        if (balanceAmount !== null) {
          await executeBuyCycle(balanceAmount);
        } else {
          console.log('No se pudo obtener balance XMD tras varios intentos.');
        }
        lastRun.buy = key;
      }

      if (hour === Number(sendAtUtc.hour) && minute === Number(sendAtUtc.minute) && lastRun.send !== key) {
        console.log('Hora de envío alcanzada, ejecutando ciclo de envío...');
        await executeSendCycle();
        lastRun.send = key;
      }
    } catch (error) {
      console.error('Error en loop principal:', error.message || error);
    }

    await sleep(1000);
  }
};

runForever();
