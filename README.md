# Bot v3 — TradingView → BingX

Cópia funcional do **Bot v2** (Bybit), a executar na **BingX**, com canal Telegram próprio.
Toda a lógica de negociação é idêntica à do v2 — só a camada de exchange muda.

## Relação com o Bot v2

| | Bot v2 | Bot v3 |
|---|---|---|
| Branch | `v2` | `v3` (mesmo repo) |
| Exchange | Bybit (API v5) | BingX (open-api, swap) |
| Telegram | bot/canal do v2 | **bot/canal próprios** |
| Comandos | `/pnl2 /pos2 /commit2 /close2` | `/pnl3 /pos3 /commit3 /close3` (+ `/stats7`, `/stats30`) |
| Webhook | serviço Railway do v2 | **serviço Railway próprio** (URL distinto) |

Os dois são independentes: serviços, chaves, estado e canais separados. O v2 continua
a funcionar exatamente como antes.

## Diferenças técnicas Bybit → BingX

A lógica de negociação não mudou; o que mudou foi como se fala com a exchange:

- **Autenticação**: HMAC-SHA256 sobre a query string, `X-BX-APIKEY` no header
  (a Bybit assina `timestamp+key+recvWindow+body`). Sem passphrase.
- **Símbolos**: BingX usa `BTC-USDT`. O bot mantém a forma sem hífen (`BTCUSDT`) no
  estado/TradingView e converte só na fronteira da API (`toBingxSymbol`).
- **SL / TP / trailing**: na Bybit são atributos da posição (`trading-stop`); na BingX
  são **ordens separadas** (`STOP_MARKET`, `TAKE_PROFIT_MARKET`, `TRAILING_STOP_MARKET`).
  `getOpenPosition` reconstrói a vista à Bybit lendo as ordens condicionais abertas,
  para que toda a lógica existente (espelhamento, breakeven, herança de TP) funcione.
- **Trailing**: BingX usa `priceRate` (rácio da distância) em vez de distância absoluta;
  a conversão mantém a garantia de breakeven via `activationPrice` = entrada ± distância.
- **PnL fechado**: `user/income` (REALIZED_PNL) em vez de `position/closed-pnl`.
- **Intervalos**: `"1h"`, `"4h"`… em vez de `"60"`, `"240"`.
- **Modo one-way**: garantido no arranque (`positionSide=BOTH` em todas as ordens).
- **API keys**: não expiram aos 3 meses como na Bybit — o aviso de expiração é no-op.

## Deploy (Railway)

Serviço novo, apontado a este repo na branch `v3`:

1. **Volume** montado em `/data` + `DATA_DIR=/data` (senão o estado perde-se em cada deploy)
2. Variáveis: ver `.env.example` (`BINGX_API_KEY`, `BINGX_SECRET_KEY`, `TELEGRAM_*` novos,
   `WEBHOOK_SECRET` **diferente** do v2)
3. `PAPER_TRADING=true` até validares; depois `false`
4. Webhook: `https://<dominio-v3>.up.railway.app/webhook`

Enquanto os alertas do TradingView não forem migrados, o v3 fica a correr sem receber
sinais — o URL distinto permite migrar depois mudando só o endpoint no TradingView.
