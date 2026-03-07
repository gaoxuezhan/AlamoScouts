/**
 * 统一配置文件（唯一配置入口）
 *
 * 使用方式：
 * 1) 直接修改本文件中的值
 * 2) 修改后重启服务：npm start
 */
module.exports = {
    server: {
        // Web 服务端口
        port: 3000,
    },

    task: {
        // 轮询间隔（分钟）
        pollIntervalMinutes: 5,
        // 航班检索条件
        flightDate: '2026-04-01',
        departure: 'BJS',
        arrival: 'SYX',
        flightNo: 'CZ6714',
    },

    browser: {
        // false=可视化窗口，true=无头
        headless: true,
        // 可视模式下每轮抓取后停留时长（毫秒）
        visibleHoldMs: 8000,
        // 启动时自动检查/下载 Camoufox 浏览器
        camoufoxAutoFetch: true,
        // Camoufox 启动参数
        os: ['windows', 'macos'],
        locale: ['zh-CN', 'en-US'],
        humanize: 1.2,
        blockWebrtc: true,
    },

    crawler: {
        // RequestQueue 名称（用于持久化队列）
        requestQueueName: 'ly-cz6714-price-monitor',
        keepAlive: true,
        minConcurrency: 1,
        maxConcurrency: 1,
        maxRequestRetries: 2,
        maxSessionRotations: 5,
        retryOnBlocked: true,
        useSessionPool: true,
        requestHandlerTimeoutSecs: 180,
        sessionPoolOptions: {
            maxPoolSize: 40,
            sessionOptions: {
                maxUsageCount: 30,
                maxErrorScore: 2,
            },
        },
    },

    proxy: {
        // 代理池；空数组表示不使用代理
        urls: [],
        // 使用代理时，是否启用 geoip
        geoipWithProxy: true,
    },

    antiBlocking: {
        // 命中这些状态码时视为被拦截
        blockedStatusCodes: [401, 403, 429, 503],
        // 页面出现这些关键字时视为触发风控
        blockSignals: [
            'captcha',
            'security check',
            'are you human',
            'access denied',
            'forbidden',
            'robot check',
            '验证码',
            '访问过于频繁',
            '异常访问',
            '人机验证',
        ],
    },

    extraction: {
        // 滚动采集最多轮数（覆盖页面懒加载）
        maxScrollPasses: 12,
        // 每轮滚动后等待渲染时间（毫秒）
        scrollWaitMs: 1400,
        // 页面稳定后再提取前的额外等待（毫秒）
        postLoadWaitBaseMs: 2200,
        postLoadWaitJitterMs: 1200,
        // 可见文本提取时，航班行前后扫描窗口
        visibleWindowBeforeLines: 2,
        visibleWindowAfterLines: 14,
        // 可见文本片段长度限制
        snippetLimit: 260,
        // HTML 兜底提取范围（从命中 flightNo 开始截取长度）
        htmlSearchWindowSize: 2500,
        // HTML 片段长度限制
        htmlSnippetLimit: 220,
    },

    storage: {
        outputDirName: 'output',
        outputFileName: 'flight-price-results.ndjson',
        // /history 接口内存保留条数
        historyLimit: 200,
    },

    timeouts: {
        navigationMs: 90000,
        networkIdleMs: 20000,
    },

    api: {
        historyDefaultLimit: 20,
        historyMaxLimit: 500,
    },
};
