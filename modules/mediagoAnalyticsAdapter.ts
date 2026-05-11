import adapter from '../libraries/analyticsAdapter/AnalyticsAdapter.js';
import {prefixLog, extractDomainFromHost} from '../src/utils.js';
import adapterManager from '../src/adapterManager.js';
import {EVENTS} from '../src/constants.js';
import {ajax} from '../src/ajax.js';
import type {DefaultOptions} from '../libraries/analyticsAdapter/AnalyticsAdapter.js';

// ==================== Configuration Constants ====================

/**
 * Mediago Analytics endpoint URL
 */
export const MediagoAnalyticsEP = 'https://media.kasiki.net/api/v1/auction-data/analytics';

/**
 * Supported event types (configurable for extension)
 * Note: AUCTION_INIT is tracked but not reported - only used to store timestamp
 */
const SUPPORTED_EVENTS = {
  AUCTION_END: EVENTS.AUCTION_END,
  BID_WON: EVENTS.BID_WON,
} as const;

/**
 * Event type mapping (for evt field)
 */
const EVENT_TYPE_MAP = {
  [EVENTS.AUCTION_INIT]: 'auctionInit',
  [EVENTS.AUCTION_END]: 'auctionEnd',
  [EVENTS.BID_WON]: 'bidWon',
} as const;

/**
 * Bid fields to remove
 */
const BID_FIELDS_TO_REMOVE = ['ad', 'adUrl', 'vastXML'] as const;

/**
 * Default configuration
 */
const DEFAULT_CONFIG = {
  logType: 'prebid',
  from: 2,
  gvlid: 1020,
  batchSize: 1,
  batchDelay: 100,
} as const;

// ==================== Type Definitions ====================

type BaseOptions = {
  /**
   * Endpoint URL (optional, defaults to MediagoAnalyticsEP)
   */
  endpoint?: string;
  /**
   * HTTP method, defaults to 'POST'
   */
  method?: string;
  /**
   * Batch size, defaults to 1
   */
  batchSize?: number;
  /**
   * Batch delay in milliseconds, defaults to 100
   */
  batchDelay?: number;
  /**
   * Global vendor list ID
   */
  gvlid?: number;
}

declare module '../libraries/analyticsAdapter/AnalyticsAdapter' {
  interface AnalyticsProviderConfig {
    mediago: {
      options: DefaultOptions & BaseOptions
    }
  }
}

// ==================== Utility Functions ====================

/**
 * Get User Agent string
 */
function getUserAgent(): string {
  return typeof navigator !== 'undefined' && navigator.userAgent ? navigator.userAgent : '';
}

/**
 * Get second-level domain from current page
 * Examples:
 *   www.example.com -> example.com
 *   subdomain.example.com -> example.com
 *   example.co.uk -> example.co.uk
 *   example.com -> example.com
 */
function getSecondLevelDomain(): string | null {
  if (typeof window === 'undefined' || !window.location) {
    return null;
  }

  try {
    const hostname = window.location.hostname;

    // Use Prebid's extractDomainFromHost function which handles
    // complex cases like .co.uk, .com.au, etc.
    const domain = extractDomainFromHost(hostname);

    if (domain) {
      // Remove www. prefix if present
      if (domain.startsWith('www.')) {
        return domain.substring(4);
      }
      return domain;
    }

    // Fallback: simple extraction if extractDomainFromHost fails
    let simpleDomain = hostname;
    if (simpleDomain.startsWith('www.')) {
      simpleDomain = simpleDomain.substring(4);
    }

    const parts = simpleDomain.split('.');
    if (parts.length <= 2) {
      return simpleDomain;
    }

    // Take last 2 parts for most cases
    return parts.slice(-2).join('.');
  } catch (e) {
    return null;
  }
}

/**
 * Process auction-level data
 */
function processAuctionLevelData(eventType: string, args: any, auctionInitTimestamp?: number): any {
  const result: any = {
    logType: DEFAULT_CONFIG.logType,
    evt: EVENT_TYPE_MAP[eventType] || eventType,
    from: DEFAULT_CONFIG.from,
    ua: getUserAgent(),
  };

  // Add domain (second-level domain)
  const domain = getSecondLevelDomain();
  if (domain) {
    result.domain = domain;
  }

  // Calculate auctionElapseTime (time difference from auctionInit)
  if (auctionInitTimestamp && args.timestamp) {
    result.auctionElapseTime = args.timestamp - auctionInitTimestamp;
  } else if (args.timestamp) {
    // If no auctionInit timestamp but current event is auctionInit, set to 0
    result.auctionElapseTime = 0;
  }

  return result;
}

/**
 * Process bid-level data
 */
function processBidLevelData(bid: any): any {
  const processedBid: any = {
    ...bid
  };

  // If bidId doesn't exist, use requestId as bidId
  if (!processedBid.bidId && processedBid.requestId) {
    processedBid.bidId = processedBid.requestId;
  }

  // Add ext field as empty json object
  processedBid.ext = {};

  // Add bidElapsedTime from bid.timeToRespond
  if (typeof bid.timeToRespond === 'number') {
    processedBid.bidElapsedTime = bid.timeToRespond;
  }

  // Add bidder field as fallback for bidderCode
  processedBid.bidder = bid.bidderCode || bid.bidder || '';

  // Set slotid from adUnitCode
  if (bid.adUnitCode) {
    processedBid.slotid = bid.adUnitCode;
  }

  // Set bidderSource from src
  if (bid.src) {
    processedBid.bidderSource = bid.src;
  }

  // Remove unwanted fields
  BID_FIELDS_TO_REMOVE.forEach(field => {
    delete processedBid[field];
  });

  return processedBid;
}

// ==================== Main Adapter ====================

let auctionInitTimestamps: Map<string, number> = new Map();
let bidderRequestsMap: Map<string, any> = new Map(); // Store bidderRequests by auctionId
let eventQueue: any[] = [];
let batchTimer: ReturnType<typeof setTimeout> | null = null;
let options: BaseOptions = {};

/**
 * Send batch of events
 */
function sendBatch() {
  if (batchTimer) {
    clearTimeout(batchTimer);
    batchTimer = null;
  }

  if (eventQueue.length === 0) {
    return;
  }

  const batch = [...eventQueue];
  eventQueue = [];

  // Ensure options are set, use defaults if not
  const endpoint = (options && options.endpoint) ? options.endpoint : MediagoAnalyticsEP;
  const method = (options && options.method) ? options.method : 'POST';

  if (!endpoint) {
    return;
  }

  try {
    ajax(
      endpoint,
      () => {
        // Success callback
      },
      JSON.stringify(batch),
      {
        method,
        contentType: 'application/json',
        withCredentials: false
      }
    );
  } catch (e) {
    // Log error but don't throw
    const {logError} = prefixLog('Mediago analytics:');
    logError('Error sending batch', e);
  }
}

const mediagoAnalytics: any = Object.assign(adapter({analyticsType: 'endpoint'}), {
  track({eventType, args}: { eventType: string, args: any }) {
    // Only process if enabled
    if (!mediagoAnalytics.enabled) {
      return;
    }

    // Handle AUCTION_INIT separately - only store timestamp, don't report
    if (eventType === EVENTS.AUCTION_INIT) {
      // Store auctionInit timestamp for later use in auctionEnd/bidWon
      if (args.auctionId && args.timestamp) {
        auctionInitTimestamps.set(args.auctionId, args.timestamp);
      }
      // Don't add to queue - auctionInit is not reported
      return;
    }

    // Only process supported events (auctionEnd and bidWon)
    if (!Object.values(SUPPORTED_EVENTS).includes(eventType as any)) {
      return;
    }

    let processedEvent: any;

    if (eventType === EVENTS.AUCTION_END) {
      // Get corresponding auctionInit timestamp
      const auctionInitTimestamp = args.auctionId ? auctionInitTimestamps.get(args.auctionId) : undefined;

      // Process auction-level data
      const auctionData = processAuctionLevelData(EVENTS.AUCTION_END, args, auctionInitTimestamp);

      // Process all bid arrays
      const processedArgs: any = {
        ...args
      };

      // Create a map of bidsReceived by requestId for quick lookup
      const bidsReceivedMap = new Map<string, any>();
      if (Array.isArray(args.bidsReceived)) {
        args.bidsReceived.forEach((bid: any) => {
          const processedBid = processBidLevelData(bid);
          if (bid.requestId) {
            bidsReceivedMap.set(bid.requestId, processedBid);
          }
        });
      }

      // Process bidsRejected array
      if (Array.isArray(args.bidsRejected)) {
        processedArgs.bidsRejected = args.bidsRejected.map((bid: any) => processBidLevelData(bid));
      }

      // Process winningBids array
      if (Array.isArray(args.winningBids)) {
        processedArgs.winningBids = args.winningBids.map((bid: any) => processBidLevelData(bid));
      }

      // Process bidderRequests[].bids array and merge bidsReceived data
      if (Array.isArray(args.bidderRequests)) {
        processedArgs.bidderRequests = args.bidderRequests.map((bidderRequest: any) => {
          const processedBidderRequest = { ...bidderRequest };
          if (Array.isArray(bidderRequest.bids)) {
            processedBidderRequest.bids = bidderRequest.bids.map((bid: any) => {
              const processedBid = processBidLevelData(bid);
              // Match bidsReceived by requestId (from bid) and bidId (from bidRequest)
              if (bid.bidId && bidsReceivedMap.has(bid.bidId)) {
                // Add mmBid object from bidsReceived to the corresponding bid in bidderRequests
                processedBid.mmBid = bidsReceivedMap.get(bid.bidId);
              }
              return processedBid;
            });
          }
          return processedBidderRequest;
        });

        // Store processed bidderRequests by auctionId for BID_WON event
        if (args.auctionId) {
          bidderRequestsMap.set(args.auctionId, processedArgs.bidderRequests);
        }
      }

      // Remove outer bidsReceived array
      delete processedArgs.bidsReceived;

      processedEvent = {
        ...auctionData,
        ...processedArgs
      };
    } else if (eventType === EVENTS.BID_WON) {
      // Get corresponding auctionInit timestamp
      const auctionInitTimestamp = args.auctionId ? auctionInitTimestamps.get(args.auctionId) : undefined;

      // Process auction-level data
      const auctionData = processAuctionLevelData(EVENTS.BID_WON, args, auctionInitTimestamp);

      // Process bid-level data (for mmBid)
      const processedBid = processBidLevelData(args);

      // Find corresponding bidderRequest and bidRequest from bidderRequestsMap
      let matchedBidderRequest: any = null;
      let matchedBidRequest: any = null;

      if (args.auctionId && args.requestId) {
        const bidderRequests = bidderRequestsMap.get(args.auctionId);
        if (Array.isArray(bidderRequests)) {
          // Search through all bidderRequests to find the matching bidRequest
          for (const bidderRequest of bidderRequests) {
            if (Array.isArray(bidderRequest.bids)) {
              const matchingBid = bidderRequest.bids.find((bid: any) => bid.bidId === args.requestId);
              if (matchingBid) {
                matchedBidderRequest = bidderRequest;
                matchedBidRequest = matchingBid;
                break;
              }
            }
          }
        }
      }

      // Build bidderRequests array
      const bidderRequestsArray: any[] = [];

      if (matchedBidderRequest && matchedBidRequest) {
        // Found matching bidderRequest and bidRequest
        // Create a copy of bidderRequest with only the matching bidRequest in bids array
        const processedBidderRequest = {
          ...matchedBidderRequest
        };

        // Create a copy of bidRequest with mmBid added
        const processedBidRequest = {
          ...matchedBidRequest,
          mmBid: processedBid
        };

        // Set bids array to only contain the matching bidRequest
        processedBidderRequest.bids = [processedBidRequest];

        bidderRequestsArray.push(processedBidderRequest);
      } else {
        // No matching bidderRequest/bidRequest found, create a minimal structure
        // Use processedBid to create a minimal bidRequest
        const minimalBidRequest = {
          bidId: processedBid.bidId || processedBid.requestId,
          bidderRequestId: processedBid.bidderRequestId || '',
          adUnitCode: processedBid.adUnitCode || '',
          bidder: processedBid.bidder || processedBid.bidderCode || '',
          mmBid: processedBid
        };

        const minimalBidderRequest = {
          bidderRequestId: processedBid.bidderRequestId || '',
          bidderCode: processedBid.bidder || processedBid.bidderCode || '',
          auctionId: args.auctionId || '',
          pageViewId: args.pageViewId || '',
          bids: [minimalBidRequest]
        };

        bidderRequestsArray.push(minimalBidderRequest);
      }

      // Return result with bidderRequests array (no finalWonBid field)
      processedEvent = {
        ...auctionData,
        bidderRequests: bidderRequestsArray
      };
    } else {
      return;
    }

    // Add to queue
    eventQueue.push(processedEvent);

    // Check if we should send batch
    // Use default batchSize if options is not set or batchSize is undefined
    const currentBatchSize = (options && typeof options.batchSize === 'number') ? options.batchSize : DEFAULT_CONFIG.batchSize;
    if (eventQueue.length >= currentBatchSize) {
      sendBatch();
    } else {
      // Schedule batch send after delay
      const currentBatchDelay = (options && typeof options.batchDelay === 'number') ? options.batchDelay : DEFAULT_CONFIG.batchDelay;
      if (batchTimer) {
        clearTimeout(batchTimer);
      }
      batchTimer = setTimeout(() => {
        sendBatch();
      }, currentBatchDelay);
    }
  }
});

mediagoAnalytics.originEnableAnalytics = mediagoAnalytics.enableAnalytics;

mediagoAnalytics.enableAnalytics = function(config: any) {
  const {logError} = prefixLog('Mediago analytics:');

  const configOptions = config?.options || {};

  // Validate endpoint
  if (!configOptions.endpoint && !MediagoAnalyticsEP) {
    logError('Endpoint URL is required');
    return;
  }

  // Store options with defaults - must be set before calling originEnableAnalytics
  options = {
    endpoint: configOptions.endpoint || MediagoAnalyticsEP,
    method: configOptions.method || 'POST',
    batchSize: (configOptions.batchSize !== undefined && configOptions.batchSize !== null) ? configOptions.batchSize : DEFAULT_CONFIG.batchSize,
    batchDelay: (configOptions.batchDelay !== undefined && configOptions.batchDelay !== null) ? configOptions.batchDelay : DEFAULT_CONFIG.batchDelay,
    gvlid: configOptions.gvlid || DEFAULT_CONFIG.gvlid,
  };

  // Reset state before enableAnalytics
  auctionInitTimestamps.clear();
  bidderRequestsMap.clear();
  eventQueue = [];
  if (batchTimer) {
    clearTimeout(batchTimer);
    batchTimer = null;
  }

  // Call original enableAnalytics to set enabled flag
  // This must be called after options are set, as track may be called during enableAnalytics
  mediagoAnalytics.originEnableAnalytics(config);
};

mediagoAnalytics.originDisableAnalytics = mediagoAnalytics.disableAnalytics;

mediagoAnalytics.disableAnalytics = function() {
  // Send any remaining events
  sendBatch();

  // Clear state
  auctionInitTimestamps.clear();
  bidderRequestsMap.clear();
  eventQueue = [];
  if (batchTimer) {
    clearTimeout(batchTimer);
    batchTimer = null;
  }

  // Call original disableAnalytics
  mediagoAnalytics.originDisableAnalytics();
};

mediagoAnalytics.gvlid = function(config: any) {
  return config?.options?.gvlid || DEFAULT_CONFIG.gvlid;
};

adapterManager.registerAnalyticsAdapter({
  adapter: mediagoAnalytics,
  code: 'mediago',
  gvlid: DEFAULT_CONFIG.gvlid,
});

export function MediagoAnalytics() {
  return mediagoAnalytics;
}

export default mediagoAnalytics;
