const express = require('express');
const { mkdir, appendFile } = require('node:fs/promises');
const { join } = require('node:path');
const {
    BasicCrawler,
    RequestQueue,
    ProxyConfiguration,
    log,
} = require('crawlee');
const { Camoufox, downloadBrowser } = require('camoufox');
const config = require('./config');

// =========================
// 运行配置（统一从 src/config.js 读取）
// 修改 config.js 后，需要重启服务 npm start 才会生效。
// =========================
const PORT = config.server.port;
const POLL_INTERVAL_MINUTES = config.task.pollIntervalMinutes;
const POLL_INTERVAL_MS = Math.max(30_000, Math.round(POLL_INTERVAL_MINUTES * 60_000));
const FLIGHT_DATE = config.task.flightDate;
const DEPARTURE = config.task.departure;
const ARRIVAL = config.task.arrival;
const FLIGHT_NO = String(config.task.flightNo).toUpperCase();
const HEADLESS = Boolean(config.browser.headless);
const VISIBLE_HOLD_MS = Math.max(0, config.browser.visibleHoldMs);
const CAMOUFOX_AUTO_FETCH = Boolean(config.browser.camoufoxAutoFetch);
const HISTORY_LIMIT = Math.max(1, config.storage.historyLimit);
const PROXY_URLS = (config.proxy.urls ?? []).map((item) => String(item).trim()).filter(Boolean);

// 结果落盘路径：每次抓取一行 JSON（ndjson）
const OUTPUT_DIR = join(process.cwd(), config.storage.outputDirName);
const OUTPUT_FILE = join(OUTPUT_DIR, config.storage.outputFileName);

// 运行时状态（内存）
// 说明：服务重启后会清空；持久化数据看 OUTPUT_FILE。
let monitorStarted = false;
let requestQueue;
let crawler;
let crawlerPromise;
let enqueueTimer;
let proxyConfiguration = null;
let inFlight = 0;
let latestResult = null;
const history = [];
const sseClients = new Set();

// 生成同程查询 URL
// 0167_buildLyUrl_执行buildLyUrl相关逻辑
function buildLyUrl(date) {
    return `https://www.ly.com/flights/itinerary/oneway/${DEPARTURE}-${ARRIVAL}?date=${date}`;
}

// 从最终 URL 读取 date 参数，用于判断是否被站点重定向了日期。
// 0168_pickDateFromUrl_从逻辑
function pickDateFromUrl(url) {
    try {
        const parsed = new URL(url);
        return parsed.searchParams.get('date');
    } catch {
        return null;
    }
}

// 安全转义正则特殊字符，避免航班号包含特殊字符时误匹配。
// 0169_escapeRegex_执行escapeRegex相关逻辑
function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 简单反封禁判定：根据标题 + 可见正文关键字识别“人机验证/访问受限”。
// 注意：这是启发式策略，不是 100% 准确。
// 0170_detectBlockedPage_页面逻辑
function detectBlockedPage(text, title) {
    const haystack = `${title || ''}\n${text || ''}`.toLowerCase();
    const blockSignals = config.antiBlocking.blockSignals ?? [];

    return blockSignals.some((signal) => haystack.includes(signal));
}

// 把“¥1,470起”这类文本归一化成数值 1470。
// 0171_parsePrice_解析逻辑
function parsePrice(rawPrice) {
    if (!rawPrice) return null;
    const normalized = String(rawPrice).replace(/[^0-9]/g, '');
    if (!normalized) return null;
    const value = Number(normalized);
    if (!Number.isFinite(value)) return null;
    return value;
}

// 优先策略：从可见文本中提取航班附近价格。
// 原因：同程页面可能是动态渲染/懒加载，page.content() 未必完整。
// 0172_extractPriceFromVisibleText_从逻辑
function extractPriceFromVisibleText(pageText, flightNo) {
    const flightNoUpper = flightNo.toUpperCase();
    const lines = pageText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

    const hitIndexes = [];
    for (let i = 0; i < lines.length; i += 1) {
        if (lines[i].toUpperCase().includes(flightNoUpper)) {
            hitIndexes.push(i);
        }
    }

    if (hitIndexes.length === 0) {
        return null;
    }

    for (const idx of hitIndexes) {
        const start = Math.max(0, idx - config.extraction.visibleWindowBeforeLines);
        const end = Math.min(lines.length, idx + config.extraction.visibleWindowAfterLines);
        const windowLines = lines.slice(start, end);
        const windowText = windowLines.join(' | ');
        const priceMatch = windowText.match(/[¥￥]\s*([0-9][0-9,]*)/i);
        const parsedPrice = parsePrice(priceMatch?.[1]);
        if (parsedPrice != null) {
            return {
                price: parsedPrice,
                method: 'visible-text-near-flight',
                snippet: windowText.slice(0, config.extraction.snippetLimit),
            };
        }
    }

    const fallbackWindowStart = Math.max(0, hitIndexes[0] - config.extraction.visibleWindowBeforeLines);
    const fallbackWindowEnd = Math.min(lines.length, hitIndexes[0] + config.extraction.visibleWindowAfterLines);
    return {
        price: null,
        method: 'visible-flight-found-price-missing',
        snippet: lines.slice(fallbackWindowStart, fallbackWindowEnd).join(' | ').slice(0, config.extraction.snippetLimit),
    };
}

// 滚动采集页面可见文本，尽量覆盖底部懒加载航班（例如目标航班在最后一行）。
// 0173_collectPageTextWithScroll_页面逻辑
async function collectPageTextWithScroll(page, flightNo) {
    const target = flightNo.toUpperCase();
    let longestText = '';
    let unchangedRounds = 0;
    let lastScrollHeight = 0;

    // 同程列表存在懒加载；这里使用页面内滚动而非 mouse.wheel，
    // 避免窗口不在最前台时滚轮事件被系统降级/丢失。
    for (let pass = 0; pass < config.extraction.maxScrollPasses; pass += 1) {
        const pageText = await page.locator('body').innerText().catch(() => '');
        if (pageText.length > longestText.length) {
            longestText = pageText;
        }

        if (pageText.toUpperCase().includes(target)) {
            return pageText;
        }

        const metrics = await page.evaluate(() => {
            const root = document.scrollingElement || document.documentElement || document.body;
            const viewport = window.innerHeight || 900;
            const maxTop = Math.max(0, root.scrollHeight - viewport);
            const nextTop = Math.min(root.scrollTop + Math.max(1800, Math.floor(viewport * 0.9)), maxTop);
            root.scrollTop = nextTop;
            window.scrollTo(0, nextTop);
            return {
                scrollTop: root.scrollTop,
                scrollHeight: root.scrollHeight,
                atBottom: nextTop >= maxTop,
            };
        }).catch(() => ({ scrollTop: 0, scrollHeight: 0, atBottom: false }));

        if (metrics.scrollHeight === lastScrollHeight) {
            unchangedRounds += 1;
        } else {
            unchangedRounds = 0;
            lastScrollHeight = metrics.scrollHeight;
        }

        await page.waitForTimeout(config.extraction.scrollWaitMs);

        // 已到底部且连续多轮无新增内容时提前结束，减少无效等待。
        if (metrics.atBottom && unchangedRounds >= 2) {
            break;
        }
    }

    return longestText;
}

// 兜底策略：从 HTML（含脚本）中做 regex 提取。
// 当可见文本提取失败时，尝试从序列化数据结构中拿价格字段。
// 0174_extractPriceByFlightNo_执行extractPriceByFlightNo相关逻辑
function extractPriceByFlightNo(html, flightNo) {
    const escapedFlightNo = escapeRegex(flightNo);
    const directFlightRegex = new RegExp(`flightNo["']?\\s*[:=]\\s*["']${escapedFlightNo}["']`, 'i');
    const directMatch = directFlightRegex.exec(html);

    const fallbackTextRegex = new RegExp(`${escapedFlightNo}[\\s\\S]{0,160}?[¥￥]\\s*([0-9]{2,6})`, 'i');

    if (!directMatch) {
        const fallbackMatch = fallbackTextRegex.exec(html);
        if (fallbackMatch) {
            return {
                price: Number(fallbackMatch[1]),
                method: 'fallback-nearby-symbol',
                snippet: fallbackMatch[0].slice(0, config.extraction.htmlSnippetLimit),
            };
        }

        return null;
    }

    const snippet = html.slice(directMatch.index, directMatch.index + config.extraction.htmlSearchWindowSize);
    const candidates = [
        { method: 'flightPrice-field', regex: /flightPrice["']?\s*[:=]\s*"?([0-9]{2,6})"?/i },
        { method: 'productPrices-field', regex: /productPrices\s*:\s*\{\s*["']?0["']?\s*:\s*([0-9]{2,6})/i },
        { method: 'ap-field', regex: /\bap["']?\s*:\s*"?([0-9]{2,6})"?/i },
        { method: 'lcp-field', regex: /\blcp["']?\s*:\s*"?([0-9]{2,6})"?/i },
        { method: 'symbol-field', regex: /[¥￥]\s*([0-9]{2,6})/i },
    ];

    for (const candidate of candidates) {
        const match = candidate.regex.exec(snippet);
        if (match) {
            return {
                price: Number(match[1]),
                method: candidate.method,
                snippet: snippet.slice(0, config.extraction.htmlSnippetLimit),
            };
        }
    }

    const looseNumberMatches = [...snippet.matchAll(/\b([1-9][0-9]{2,4})\b/g)]
        .map((match) => Number(match[1]))
        .filter((value) => value >= 100 && value <= 20000);

    if (looseNumberMatches.length > 0) {
        return {
            price: looseNumberMatches[0],
            method: 'loose-number-fallback',
            snippet: snippet.slice(0, config.extraction.htmlSnippetLimit),
        };
    }

    return {
        price: null,
        method: 'flight-found-but-price-missing',
        snippet: snippet.slice(0, config.extraction.htmlSnippetLimit),
    };
}

// 向所有 SSE 客户端广播最新结果。
// 0175_emitToSseClients_发出到SSE逻辑
function emitToSseClients(payload) {
    const text = `data: ${JSON.stringify(payload)}\n\n`;
    for (const client of sseClients) {
        client.write(text);
    }
}

// 统一处理结果：更新内存、落盘、日志、SSE 推送。
// 0176_persistAndBroadcast_持久化逻辑
async function persistAndBroadcast(result) {
    latestResult = result;
    history.push(result);

    if (history.length > HISTORY_LIMIT) {
        history.splice(0, history.length - HISTORY_LIMIT);
    }

    await appendFile(OUTPUT_FILE, `${JSON.stringify(result)}\n`, 'utf8');

    const marker = result.price == null ? 'N/A' : `CNY ${result.price}`;
    log.info(`[price-update] ${result.timestamp} ${FLIGHT_NO}: ${marker}`);

    if (result.note) {
        log.warning(`[price-note] ${result.note}`);
    }

    emitToSseClients(result);
}

// 单次抓取任务（核心流程）
// 流程：取代理 -> 启 Camoufox -> 导航 -> 反封禁判定 -> 提取价格 -> 写入结果。
// 0177_runSingleCheck_执行检查逻辑
async function runSingleCheck(context) {
    const startedAt = new Date();
    const url = buildLyUrl(FLIGHT_DATE);
    const sessionId = context.session?.id ?? null;
    const proxySessionId = sessionId ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const rotatedProxyInfo = proxyConfiguration
        ? await proxyConfiguration.newProxyInfo(proxySessionId)
        : null;
    // 代理轮换：同一 session 会复用代理，session 退休后会切到新代理
    const proxyUrl = rotatedProxyInfo?.url ?? null;

    let browser;
    let page;

    try {
        // 使用 Camoufox（隐形 Firefox）+ 可选代理，提升稳定性与反识别能力。
        browser = await Camoufox({
            headless: HEADLESS,
            os: config.browser.os,
            locale: config.browser.locale,
            humanize: config.browser.humanize,
            block_webrtc: config.browser.blockWebrtc,
            proxy: proxyUrl || undefined,
            geoip: proxyUrl ? config.proxy.geoipWithProxy : false,
        });

        page = await browser.newPage();
        page.setDefaultNavigationTimeout(config.timeouts.navigationMs);
        await page.bringToFront().catch(() => {});

        // 恢复 session cookies，保持会话连续性（对抗频繁新会话触发风控）。
        const existingCookies = context.session?.getCookies(url) ?? [];
        if (existingCookies.length > 0) {
            await page.context().addCookies(existingCookies);
        }

        const response = await page.goto(url, {
            waitUntil: 'domcontentloaded',
            timeout: config.timeouts.navigationMs,
        });

        await page.waitForLoadState('networkidle', { timeout: config.timeouts.networkIdleMs }).catch(() => {});
        await page.waitForTimeout(
            config.extraction.postLoadWaitBaseMs + Math.floor(Math.random() * config.extraction.postLoadWaitJitterMs),
        );

        // 明确的封禁状态码直接判定 blocked，并退休 session。
        const statusCode = response?.status();
        if (statusCode && (config.antiBlocking.blockedStatusCodes ?? []).includes(statusCode)) {
            context.session?.retire();
            throw new Error(`blocked-status-${statusCode}`);
        }

        const title = await page.title();
        const pageText = await collectPageTextWithScroll(page, FLIGHT_NO);
        const html = await page.content();

        if (detectBlockedPage(pageText, title)) {
            context.session?.retire();
            throw new Error('blocked-by-page-signal');
        }

        // 双通道提取：先可见文本（主）再 HTML（兜底）。
        const extractedFromVisibleText = extractPriceFromVisibleText(pageText, FLIGHT_NO);
        const extractedFromHtml = extractPriceByFlightNo(html, FLIGHT_NO);
        // 可见文本命中但 price 为空时，继续尝试 HTML 兜底；若仍失败，再回退到可见文本结果。
        const extracted = extractedFromVisibleText?.price != null
            ? extractedFromVisibleText
            : extractedFromHtml ?? extractedFromVisibleText;
        const flightFound = Boolean(extracted);
        const hasPrice = extracted?.price != null;
        const finalUrl = page.url();
        const finalDate = pickDateFromUrl(finalUrl);
        const redirected = finalDate && finalDate !== FLIGHT_DATE;

        const cookiesAfter = await page.context().cookies();
        if (cookiesAfter.length > 0) {
            context.session?.setCookies(cookiesAfter, url);
        }
        // 请求成功后为 session 加分，降低 errorScore。
        context.session?.markGood();

        const result = {
            timestamp: new Date().toISOString(),
            task: {
                site: 'ly.com',
                departure: DEPARTURE,
                arrival: ARRIVAL,
                expectedDate: FLIGHT_DATE,
                flightNo: FLIGHT_NO,
            },
            status: !flightFound ? 'flight-not-found' : hasPrice ? 'ok' : 'flight-found-price-missing',
            foundFlight: flightFound,
            price: extracted?.price ?? null,
            priceCurrency: 'CNY',
            extractionMethod: extracted?.method ?? null,
            extractionSnippet: extracted?.snippet ?? null,
            requestUrl: url,
            finalUrl,
            finalDate,
            redirectedFromExpectedDate: Boolean(redirected),
            proxyUrl,
            sessionId,
            durationMs: Date.now() - startedAt.getTime(),
            triggerReason: context.request.userData.triggerReason,
            note: redirected
                ? `ly.com 将请求日期从 ${FLIGHT_DATE} 自动跳转为 ${finalDate}`
                : !flightFound
                    ? `页面中未找到航班号 ${FLIGHT_NO}`
                    : hasPrice
                        ? null
                        : `找到了航班号 ${FLIGHT_NO}，但未解析到价格`,
        };

        await persistAndBroadcast(result);

        // Keep the visible browser open briefly so the operator can observe the page.
        if (!HEADLESS && VISIBLE_HOLD_MS > 0) {
            await page.waitForTimeout(VISIBLE_HOLD_MS);
        }
    } catch (error) {
        // 出错时给 session 计坏分；达到阈值后会被淘汰并换新 session。
        context.session?.markBad();
        throw error;
    } finally {
        // 每轮都关闭页面和浏览器，避免长期进程内存泄漏。
        if (page) {
            await page.close().catch(() => {});
        }
        if (browser) {
            await browser.close().catch(() => {});
        }
    }
}

// 入队一个抓取任务。这里每次 uniqueKey 都不同，保证定时任务不会被去重。
// 0178_enqueueCheck_检查逻辑
async function enqueueCheck(triggerReason) {
    if (!requestQueue) {
        throw new Error('request queue not ready');
    }

    const runKey = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    await requestQueue.addRequest({
        url: buildLyUrl(FLIGHT_DATE),
        uniqueKey: `${FLIGHT_NO}-${FLIGHT_DATE}-${runKey}`,
        userData: {
            triggerReason,
            scheduledAt: new Date().toISOString(),
        },
    });
}

// 启动监控：
// 1) 准备目录/浏览器
// 2) 初始化代理池与队列
// 3) 启动 Crawlee keepAlive 循环
// 4) 立即抓一次 + 按间隔持续入队
// 0179_startMonitor_启动逻辑
async function startMonitor() {
    if (monitorStarted) {
        return;
    }

    try {
        await mkdir(OUTPUT_DIR, { recursive: true });

        if (CAMOUFOX_AUTO_FETCH) {
            try {
                log.info('Checking Camoufox browser binaries...');
                await downloadBrowser();
            } catch (error) {
                log.warning(`Camoufox binary prefetch failed: ${error.message}`);
            }
        }

        proxyConfiguration = PROXY_URLS.length
            ? new ProxyConfiguration({ proxyUrls: PROXY_URLS })
            : null;

        requestQueue = await RequestQueue.open(config.crawler.requestQueueName);

        crawler = new BasicCrawler({
            requestQueue,
            // keepAlive=true 表示队列空了也不退出，适合长跑服务。
            keepAlive: config.crawler.keepAlive,
            // 并发由配置文件控制。
            maxConcurrency: config.crawler.maxConcurrency,
            minConcurrency: config.crawler.minConcurrency,
            // 请求级别重试次数（不含 session 轮换带来的重试）。
            maxRequestRetries: config.crawler.maxRequestRetries,
            // 同一请求最多可触发的 session 轮换次数。
            maxSessionRotations: config.crawler.maxSessionRotations,
            retryOnBlocked: config.crawler.retryOnBlocked,
            // 开启会话池（cookies + 失败分数 + 退休机制）。
            useSessionPool: config.crawler.useSessionPool,
            sessionPoolOptions: config.crawler.sessionPoolOptions,
            requestHandlerTimeoutSecs: config.crawler.requestHandlerTimeoutSecs,
            // 0180_requestHandler_执行requestHandler相关逻辑
            async requestHandler(context) {
                inFlight += 1;
                try {
                    await runSingleCheck(context);
                } finally {
                    inFlight = Math.max(0, inFlight - 1);
                }
            },
            // 0181_failedRequestHandler_执行failedRequestHandler相关逻辑
            async failedRequestHandler({ request, session }, error) {
                // 最终失败也写入结果，避免“静默失败”。
                const fallbackResult = {
                    timestamp: new Date().toISOString(),
                    task: {
                        site: 'ly.com',
                        departure: DEPARTURE,
                        arrival: ARRIVAL,
                        expectedDate: FLIGHT_DATE,
                        flightNo: FLIGHT_NO,
                    },
                    status: 'failed',
                    foundFlight: false,
                    price: null,
                    priceCurrency: 'CNY',
                    extractionMethod: null,
                    extractionSnippet: null,
                    requestUrl: request.url,
                    finalUrl: null,
                    finalDate: null,
                    redirectedFromExpectedDate: false,
                    proxyUrl: null,
                    sessionId: session?.id ?? null,
                    durationMs: null,
                    triggerReason: request.userData.triggerReason,
                    note: `抓取失败: ${error.message}`,
                };

                await persistAndBroadcast(fallbackResult);
            },
        });

        // 启动 crawler 主循环（常驻）。
        crawlerPromise = crawler.run().catch((error) => {
            log.exception(error, 'Crawler loop crashed unexpectedly.');
        });

        // 启动后先抓一轮，再进入定时抓取。
        await enqueueCheck('startup');

        const scheduledTriggerReason = `scheduled-${POLL_INTERVAL_MINUTES}min`;
        enqueueTimer = setInterval(() => {
            void enqueueCheck(scheduledTriggerReason).catch((error) => {
                log.warning(`enqueue failed: ${error.message}`);
            });
        }, POLL_INTERVAL_MS);

        monitorStarted = true;
        log.info(`Monitor started. Poll interval: ${Math.round(POLL_INTERVAL_MS / 1000)}s`);
    } catch (error) {
        monitorStarted = false;
        if (enqueueTimer) {
            clearInterval(enqueueTimer);
            enqueueTimer = undefined;
        }
        if (crawler) {
            await crawler.stop().catch(() => {});
        }
        requestQueue = undefined;
        crawler = undefined;
        crawlerPromise = undefined;
        throw error;
    }
}

// 优雅停止：先停定时器，再停 crawler。
// 0182_stopMonitor_停止逻辑
async function stopMonitor() {
    if (enqueueTimer) {
        clearInterval(enqueueTimer);
        enqueueTimer = undefined;
    }

    if (crawler) {
        await crawler.stop().catch(() => {});
        await crawlerPromise;
    }

    monitorStarted = false;
}

const app = express();
app.use(express.json());

// 健康检查：看服务状态、目标配置、最新抓取时间。
app.get('/health', (_req, res) => {
    res.json({
        ok: true,
        monitorStarted,
        inFlight,
        pollIntervalMs: POLL_INTERVAL_MS,
        target: {
            site: 'ly.com',
            departure: DEPARTURE,
            arrival: ARRIVAL,
            expectedDate: FLIGHT_DATE,
            flightNo: FLIGHT_NO,
        },
        proxyRotationEnabled: PROXY_URLS.length > 0,
        sessionManagementEnabled: true,
        antiBlockingEnabled: true,
        latestTimestamp: latestResult?.timestamp ?? null,
    });
});

// 最新一条抓取结果（最常用接口）。
app.get('/latest', (_req, res) => {
    res.json({
        latest: latestResult,
    });
});

// 历史结果（内存），可通过 ?limit=xx 控制返回数量。
app.get('/history', (req, res) => {
    const parsedLimit = Number.parseInt(String(req.query.limit ?? config.api.historyDefaultLimit), 10);
    const normalizedLimit = Number.isFinite(parsedLimit)
        ? parsedLimit
        : config.api.historyDefaultLimit;
    const limit = Math.max(1, Math.min(config.api.historyMaxLimit, normalizedLimit));
    res.json({
        count: Math.min(limit, history.length),
        items: history.slice(-limit),
    });
});

// 手动触发一次抓取（不等下一轮定时）。
app.post('/trigger', async (_req, res) => {
    await enqueueCheck('manual-trigger');
    res.json({ ok: true, message: 'manual check queued' });
});

// SSE 实时流：每次有新结果都会推送到已连接客户端。
app.get('/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    sseClients.add(res);

    if (latestResult) {
        res.write(`data: ${JSON.stringify(latestResult)}\n\n`);
    }

    req.on('close', () => {
        sseClients.delete(res);
    });
});

// 程序入口：启动监控 + 启动 Web 服务 + 注册优雅退出信号。
// 0183_main_执行main相关逻辑
async function main() {
    log.setLevel(log.LEVELS.INFO);

    await startMonitor();

    app.listen(PORT, () => {
        log.info(`Web server listening on http://127.0.0.1:${PORT}`);
        log.info(`Latest result: GET http://127.0.0.1:${PORT}/latest`);
        log.info(`Live stream: GET http://127.0.0.1:${PORT}/stream`);
    });

    // 0184_shutdown_执行shutdown相关逻辑
    const shutdown = async (signal) => {
        log.warning(`Received ${signal}, shutting down...`);
        await stopMonitor();
        process.exit(0);
    };

    process.on('SIGINT', () => {
        void shutdown('SIGINT');
    });

    process.on('SIGTERM', () => {
        void shutdown('SIGTERM');
    });
}

main().catch((error) => {
    log.exception(error, 'Fatal startup error');
    process.exit(1);
});


