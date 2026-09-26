import { HTTP_METHODS, type HttpMethod, type LogLevel, type ParsedLogLine } from './logTypes';
import { normalizeOailbNode } from '@/utils/oailbNode';

const HTTP_METHOD_REGEX = new RegExp(`\\b(${HTTP_METHODS.join('|')})\\b`);

const LOG_TIMESTAMP_REGEX = /^\[?(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)\]?/;
const LOG_LEVEL_REGEX = /^\[?(trace|debug|info|warn|warning|error|fatal)\s*\]?(?=\s|\[|$)\s*/i;
const LOG_SOURCE_REGEX = /^\[([^\]]+)\]/;
const LOG_LATENCY_REGEX =
  /\b(?:\d+(?:\.\d+)?\s*(?:µs|us|ms|s|m))(?:\s*\d+(?:\.\d+)?\s*(?:µs|us|ms|s|m))*\b/i;
const LOG_IPV4_REGEX = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;
const LOG_IPV6_REGEX = /\b(?:[a-f0-9]{0,4}:){2,7}[a-f0-9]{0,4}\b/i;
const LOG_REQUEST_ID_REGEX = /^([a-f0-9]{8}|--------)$/i;
const LOG_CODEX_CONTEXT_REGEX =
  /^(\[[^\]]*\]\s*\[[^\]]*\]\s*\[[^\]]*\])\s*(?=\[(?:trace|debug|info|warn|warning|error|fatal)\s*\])/i;
const LOG_TIME_OF_DAY_REGEX = /^\d{1,2}:\d{2}:\d{2}(?:\.\d{1,3})?$/;
const GIN_TIMESTAMP_SEGMENT_REGEX =
  /^\[GIN\]\s+(\d{4})\/(\d{2})\/(\d{2})\s*-\s*(\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)\s*$/;

const HTTP_STATUS_PATTERNS: RegExp[] = [
  /\|\s*([1-5]\d{2})\s*\|/,
  /\b([1-5]\d{2})\s*-/,
  new RegExp(`\\b(?:${HTTP_METHODS.join('|')})\\s+\\S+\\s+([1-5]\\d{2})\\b`),
  /\b(?:status|code|http)[:\s]+([1-5]\d{2})\b/i,
  /\b([1-5]\d{2})\s+(?:OK|Created|Accepted|No Content|Moved|Found|Bad Request|Unauthorized|Forbidden|Not Found|Method Not Allowed|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout)\b/i,
];

const detectHttpStatusCode = (text: string): number | undefined => {
  for (const pattern of HTTP_STATUS_PATTERNS) {
    const match = text.match(pattern);
    if (!match) continue;
    const code = Number.parseInt(match[1], 10);
    if (!Number.isFinite(code)) continue;
    if (code >= 100 && code <= 599) return code;
  }
  return undefined;
};

const extractIp = (text: string): string | undefined => {
  const ipv4Match = text.match(LOG_IPV4_REGEX);
  if (ipv4Match) return ipv4Match[0];

  const ipv6Match = text.match(LOG_IPV6_REGEX);
  if (!ipv6Match) return undefined;

  const candidate = ipv6Match[0];

  // Avoid treating time strings like "12:34:56" as IPv6 addresses.
  if (LOG_TIME_OF_DAY_REGEX.test(candidate)) return undefined;

  // If no compression marker is present, a valid IPv6 address must contain 8 hextets.
  if (!candidate.includes('::') && candidate.split(':').length !== 8) return undefined;

  return candidate;
};

const normalizeTimestampToSeconds = (value: string): string => {
  const trimmed = value.trim();
  const match = trimmed.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
  if (!match) return trimmed;
  return `${match[1]} ${match[2]}`;
};

const extractLatency = (text: string): string | undefined => {
  const match = text.match(LOG_LATENCY_REGEX);
  if (!match) return undefined;
  return match[0].replace(/\s+/g, '');
};

const extractLogLevel = (value: string): LogLevel | undefined => {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'warning') return 'warn';
  if (normalized === 'warn') return 'warn';
  if (normalized === 'info') return 'info';
  if (normalized === 'error') return 'error';
  if (normalized === 'fatal') return 'fatal';
  if (normalized === 'debug') return 'debug';
  if (normalized === 'trace') return 'trace';
  return undefined;
};

const inferLogLevel = (line: string): LogLevel | undefined => {
  const lowered = line.toLowerCase();
  if (/\bfatal\b/.test(lowered)) return 'fatal';
  if (/\berror\b/.test(lowered)) return 'error';
  if (/\bwarn(?:ing)?\b/.test(lowered) || line.includes('警告')) return 'warn';
  if (/\binfo\b/.test(lowered)) return 'info';
  if (/\bdebug\b/.test(lowered)) return 'debug';
  if (/\btrace\b/.test(lowered)) return 'trace';
  return undefined;
};

const extractHttpMethodAndPath = (text: string): { method?: HttpMethod; path?: string } => {
  const match = text.match(HTTP_METHOD_REGEX);
  if (!match) return {};

  const method = match[1] as HttpMethod;
  const index = match.index ?? 0;
  const after = text.slice(index + match[0].length).trim();
  const path = after ? after.split(/\s+/)[0] : undefined;
  return { method, path };
};

const GIN_DURATION_REGEX = /^(?:\d+(?:\.\d+)?\s*(?:ns|µs|μs|us|ms|s|m|h)\s*)+$/i;
const GIN_METHOD_PATH_REGEX = new RegExp(
  `^(${HTTP_METHODS.join('|')})\\s+("(?:[^"\\\\]|\\\\.)*"|\\S+)(?:\\s+(.*))?$`
);

// Match complete access-log layouts before generic field inference. A valid
// node can look like an 8-digit request ID, a duration or a three-digit status.
// Models, turn-state lengths and IPs must never be guessed to be node names.
const parseGinColumns = (
  text: string,
  legacyNode?: string
):
  | Pick<
      ParsedLogLine,
      'statusCode' | 'latency' | 'oailbNode' | 'ip' | 'method' | 'path' | 'message'
    >
  | undefined => {
  const columns = text.split('|').map((column) => column.trim());
  if (!/^[1-5]\d{2}$/.test(columns[0]) || !GIN_DURATION_REGEX.test(columns[1] ?? ''))
    return undefined;

  const methodIndex = columns.findIndex((column) => GIN_METHOD_PATH_REGEX.test(column));
  if (methodIndex < 3 || methodIndex > 6) return undefined;
  const ipColumn = columns[methodIndex - 1];
  const ip = extractIp(ipColumn);
  if (ip !== ipColumn && ipColumn !== '-') return undefined;

  // Old basic / Codex: 4 / 6 columns; node-column basic / Codex: 5 / 7.
  const hasNodeColumn = methodIndex === 4 || methodIndex === 6;
  const columnNode = hasNodeColumn ? normalizeOailbNode(columns[2]) : '';
  if (hasNodeColumn && !columnNode && columns[2] !== '-') return undefined;
  const hasCodexColumns = methodIndex >= 5;
  const modelIndex = hasNodeColumn ? 3 : 2;
  if (
    hasCodexColumns &&
    (!columns[modelIndex].includes('/') || !/^\d+\/\d+$/.test(columns[modelIndex + 1]))
  )
    return undefined;

  const request = columns[methodIndex].match(GIN_METHOD_PATH_REGEX)!;
  const messageParts = hasCodexColumns ? [columns[modelIndex], columns[modelIndex + 1]] : [];
  if (request[3]) messageParts.push(request[3]);
  messageParts.push(...columns.slice(methodIndex + 1).filter(Boolean));

  return {
    statusCode: Number(columns[0]),
    latency: columns[1].replace(/\s+/g, ''),
    oailbNode: hasNodeColumn ? columnNode || undefined : legacyNode,
    ip,
    method: request[1] as HttpMethod,
    path: request[2],
    message: messageParts.join(' | '),
  };
};

export const parseLogLine = (raw: string): ParsedLogLine => {
  let remaining = raw.trim();
  // Older CPA versions append the node to the method/path segment.
  // Extract it first so those records remain compatible with column-based logs.
  let oailbNode: string | undefined;
  remaining = remaining.replace(
    /(^|[\s|])oailb_node=([^\s|]*)/g,
    (_match, boundary: string, value: string) => {
      oailbNode = normalizeOailbNode(value) || undefined;
      return boundary;
    }
  );

  let timestamp: string | undefined;
  const tsMatch = remaining.match(LOG_TIMESTAMP_REGEX);
  if (tsMatch) {
    timestamp = tsMatch[1];
    remaining = remaining.slice(tsMatch[0].length).trim();
  }

  let requestId: string | undefined;
  const requestIdMatch = remaining.match(/^\[([a-f0-9]{8}|--------)\]\s*/i);
  if (requestIdMatch) {
    const id = requestIdMatch[1];
    if (!/^-+$/.test(id)) {
      requestId = id;
    }
    remaining = remaining.slice(requestIdMatch[0].length).trim();
  }

  // These are context tags, not the source file or additional request IDs.
  // Preserve them in the visible message while parsing the actual level/source.
  const contextMatch = remaining.match(LOG_CODEX_CONTEXT_REGEX);
  const contextMessage = contextMatch?.[1] ?? '';
  if (contextMatch) remaining = remaining.slice(contextMatch[0].length).trim();

  let level: LogLevel | undefined;
  const lvlMatch = remaining.match(LOG_LEVEL_REGEX);
  if (lvlMatch) {
    level = extractLogLevel(lvlMatch[1]);
    remaining = remaining.slice(lvlMatch[0].length).trim();
  }

  let source: string | undefined;
  const sourceMatch = remaining.match(LOG_SOURCE_REGEX);
  if (sourceMatch) {
    source = sourceMatch[1];
    remaining = remaining.slice(sourceMatch[0].length).trim();
  }

  const gin = parseGinColumns(remaining, oailbNode);
  if (gin) {
    return {
      raw,
      timestamp,
      requestId,
      level: level ?? inferLogLevel(raw),
      source,
      ...gin,
      message: [contextMessage, gin.message].filter(Boolean).join(' | '),
    };
  }

  let statusCode: number | undefined;
  let latency: string | undefined;
  let ip: string | undefined;
  let method: HttpMethod | undefined;
  let path: string | undefined;
  let message = remaining;

  if (remaining.includes('|')) {
    const segments = remaining
      .split('|')
      .map((segment) => segment.trim())
      .filter(Boolean);
    const consumed = new Set<number>();

    const ginIndex = segments.findIndex((segment) => GIN_TIMESTAMP_SEGMENT_REGEX.test(segment));
    if (ginIndex >= 0) {
      const match = segments[ginIndex].match(GIN_TIMESTAMP_SEGMENT_REGEX);
      if (match) {
        const ginTimestamp = `${match[1]}-${match[2]}-${match[3]} ${match[4]}`;
        const normalizedGin = normalizeTimestampToSeconds(ginTimestamp);
        const normalizedParsed = timestamp ? normalizeTimestampToSeconds(timestamp) : undefined;

        if (!timestamp) {
          timestamp = ginTimestamp;
          consumed.add(ginIndex);
        } else if (normalizedParsed === normalizedGin) {
          consumed.add(ginIndex);
        }
      }
    }

    // request id (8-char hex or dashes)
    const requestIdIndex = segments.findIndex((segment) => LOG_REQUEST_ID_REGEX.test(segment));
    if (requestIdIndex >= 0) {
      const match = segments[requestIdIndex].match(LOG_REQUEST_ID_REGEX);
      if (match) {
        const id = match[1];
        if (!/^-+$/.test(id)) {
          requestId = id;
        }
        consumed.add(requestIdIndex);
      }
    }

    // status code
    const statusIndex = segments.findIndex((segment) => /^\d{3}$/.test(segment));
    if (statusIndex >= 0) {
      const match = segments[statusIndex].match(/^(\d{3})$/);
      if (match) {
        const code = Number.parseInt(match[1], 10);
        if (code >= 100 && code <= 599) {
          statusCode = code;
          consumed.add(statusIndex);
        }
      }
    }

    // latency
    const latencyIndex = segments.findIndex((segment) => LOG_LATENCY_REGEX.test(segment));
    if (latencyIndex >= 0) {
      const extracted = extractLatency(segments[latencyIndex]);
      if (extracted) {
        latency = extracted;
        consumed.add(latencyIndex);
      }
    }

    // ip
    const ipIndex = segments.findIndex((segment) => Boolean(extractIp(segment)));
    if (ipIndex >= 0) {
      const extracted = extractIp(segments[ipIndex]);
      if (extracted) {
        ip = extracted;
        consumed.add(ipIndex);
      }
    }

    // method + path
    const methodIndex = segments.findIndex((segment) => {
      const { method: parsedMethod } = extractHttpMethodAndPath(segment);
      return Boolean(parsedMethod);
    });
    if (methodIndex >= 0) {
      const parsed = extractHttpMethodAndPath(segments[methodIndex]);
      method = parsed.method;
      path = parsed.path;
      consumed.add(methodIndex);
    }

    // source (e.g. [gin_logger.go:94])
    const sourceIndex = segments.findIndex((segment) => LOG_SOURCE_REGEX.test(segment));
    if (sourceIndex >= 0) {
      const match = segments[sourceIndex].match(LOG_SOURCE_REGEX);
      if (match) {
        source = match[1];
        consumed.add(sourceIndex);
      }
    }

    message = segments.filter((_, index) => !consumed.has(index)).join(' | ');
  } else {
    statusCode = detectHttpStatusCode(remaining);

    const extracted = extractLatency(remaining);
    if (extracted) latency = extracted;

    ip = extractIp(remaining);

    const parsed = extractHttpMethodAndPath(remaining);
    method = parsed.method;
    path = parsed.path;
  }

  if (!level) level = inferLogLevel(raw);

  if (message) {
    const match = message.match(GIN_TIMESTAMP_SEGMENT_REGEX);
    if (match) {
      const ginTimestamp = `${match[1]}-${match[2]}-${match[3]} ${match[4]}`;
      if (!timestamp) timestamp = ginTimestamp;
      if (normalizeTimestampToSeconds(timestamp) === normalizeTimestampToSeconds(ginTimestamp)) {
        message = '';
      }
    }
  }

  return {
    raw,
    timestamp,
    level,
    source,
    requestId,
    statusCode,
    oailbNode,
    latency,
    ip,
    method,
    path,
    message: [contextMessage, message].filter(Boolean).join(' | '),
  };
};
