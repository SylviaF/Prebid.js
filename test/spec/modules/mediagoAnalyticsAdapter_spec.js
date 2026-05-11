import mediagoAnalytics, {MediagoAnalyticsEP} from '../../../modules/mediagoAnalyticsAdapter.js';
import * as events from 'src/events.js';
import {EVENTS} from 'src/constants.js';
import * as ajax from 'src/ajax.js';

const {AUCTION_INIT, BID_WON} = EVENTS;

describe('Mediago Analytics Adapter', () => {
  let sandbox, clock, ajaxStub;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    sinon.stub(events, 'getEvents').returns([]);
    clock = sandbox.useFakeTimers();
    ajaxStub = sandbox.stub(ajax, 'ajax');
  });

  afterEach(() => {
    mediagoAnalytics.disableAnalytics();
    events.getEvents.restore();
    clock.runAll();
    clock.restore();
    sandbox.restore();
  });

  describe('Configuration', () => {
    it('should enable with default endpoint', () => {
      mediagoAnalytics.enableAnalytics({
        provider: 'mediago',
        options: {}
      });
      expect(mediagoAnalytics.enabled).to.be.true;
    });

    it('should enable with custom endpoint', () => {
      const customEndpoint = 'https://custom-endpoint.com/collect';
      mediagoAnalytics.enableAnalytics({
        provider: 'mediago',
        options: {
          endpoint: customEndpoint
        }
      });
      expect(mediagoAnalytics.enabled).to.be.true;

      // Track BID_WON event to verify endpoint is used (AUCTION_INIT is not reported)
      mediagoAnalytics.track({
        eventType: BID_WON,
        args: {
          auctionId: 'test',
          timestamp: 1000,
          requestId: 'req-1',
          bidderCode: 'test',
          adId: 'ad-1',
          cpm: 2.5,
          adUnitCode: 'div-1'
        }
      });
      clock.tick(100);

      sinon.assert.calledOnce(ajaxStub);
      sinon.assert.calledWith(ajaxStub, customEndpoint, sinon.match.any, sinon.match.any, sinon.match.any);
    });

    it('should use default GVLID (1020)', () => {
      mediagoAnalytics.enableAnalytics({
        provider: 'mediago',
        options: {}
      });
      expect(mediagoAnalytics.gvlid({options: {}})).to.equal(1020);
    });

    it('should allow custom GVLID', () => {
      mediagoAnalytics.enableAnalytics({
        provider: 'mediago',
        options: {
          gvlid: 9999
        }
      });
      expect(mediagoAnalytics.gvlid({options: {gvlid: 9999}})).to.equal(9999);
    });

    it('should accept batch configuration', () => {
      mediagoAnalytics.enableAnalytics({
        provider: 'mediago',
        options: {
          batchSize: 5,
          batchDelay: 200
        }
      });
      expect(mediagoAnalytics.enabled).to.be.true;
    });
  });

  describe('Event Tracking', () => {
    beforeEach(() => {
      mediagoAnalytics.enableAnalytics({
        provider: 'mediago',
        options: {
          batchSize: 1
        }
      });
    });

    it('should only track supported events (auctionEnd and bidWon)', () => {
      // Track supported event (BID_WON)
      mediagoAnalytics.track({
        eventType: BID_WON,
        args: {
          auctionId: 'test-1',
          timestamp: 1000,
          requestId: 'req-1',
          bidderCode: 'test',
          adId: 'ad-1',
          cpm: 2.5,
          adUnitCode: 'div-1'
        }
      });
      clock.tick(100);

      sinon.assert.calledOnce(ajaxStub);
      const callArgs = ajaxStub.getCall(0).args;
      const data = JSON.parse(callArgs[2]);
      expect(data.length).to.equal(1);
      expect(data[0].evt).to.equal('bidWon');

      // Should not track unsupported event
      ajaxStub.resetHistory();
      mediagoAnalytics.track({
        eventType: EVENTS.BID_RESPONSE,
        args: {}
      });
      clock.tick(100);

      sinon.assert.notCalled(ajaxStub);
    });
  });

  describe('auctionInit Event Processing', () => {
    beforeEach(() => {
      mediagoAnalytics.enableAnalytics({
        provider: 'mediago',
        options: {
          batchSize: 1
        }
      });
    });

    it('should store auctionInit timestamp but not report it', () => {
      const args = {
        auctionId: 'auction-123',
        timestamp: 1000,
        timeout: 1000,
        adUnits: []
      };

      mediagoAnalytics.track({eventType: AUCTION_INIT, args});
      clock.tick(100);

      // AUCTION_INIT should not be reported (only stored for timestamp)
      sinon.assert.notCalled(ajaxStub);

      // Verify timestamp was stored by tracking BID_WON
      mediagoAnalytics.track({
        eventType: BID_WON,
        args: {
          auctionId: 'auction-123',
          timestamp: 1500,
          requestId: 'req-1',
          bidderCode: 'test',
          adId: 'ad-1',
          cpm: 2.5,
          adUnitCode: 'div-1'
        }
      });
      clock.tick(100);

      sinon.assert.calledOnce(ajaxStub);
      const callArgs = ajaxStub.getCall(0).args;
      const data = JSON.parse(callArgs[2]);
      const event = data[0];
      expect(event.auctionElapseTime).to.equal(500); // 1500 - 1000
    });

    it('should store auctionInit timestamp for later use', () => {
      const args = {
        auctionId: 'auction-123',
        timestamp: 1000
      };

      mediagoAnalytics.track({eventType: AUCTION_INIT, args});
      clock.tick(100);
      ajaxStub.resetHistory();

      // Track bidWon to verify timestamp was stored
      mediagoAnalytics.track({
        eventType: BID_WON,
        args: {
          auctionId: 'auction-123',
          timestamp: 1500,
          bidderCode: 'test',
          adId: 'ad-1',
          cpm: 2.5,
          adUnitCode: 'div-1'
        }
      });
      clock.tick(100);

      sinon.assert.calledOnce(ajaxStub);
      const callArgs = ajaxStub.getCall(0).args;
      const data = JSON.parse(callArgs[2]);
      const event = data[0];
      expect(event.auctionElapseTime).to.equal(500); // 1500 - 1000
    });
  });

  describe('bidWon Event Processing', () => {
    beforeEach(() => {
      mediagoAnalytics.enableAnalytics({
        provider: 'mediago',
        options: {
          batchSize: 1
        }
      });

      // First track auctionInit to set up timestamp
      mediagoAnalytics.track({
        eventType: AUCTION_INIT,
        args: {
          auctionId: 'auction-123',
          timestamp: 1000
        }
      });
      clock.tick(100);
      ajaxStub.resetHistory();
    });

    it('should process bidWon with auction-level and bid-level data', () => {
      const bidArgs = {
        auctionId: 'auction-123',
        timestamp: 1500,
        bidderCode: 'pubmatic',
        adId: 'ad-123',
        requestId: 'req-456',
        cpm: 2.5,
        currency: 'USD',
        adUnitCode: 'div-1',
        timeToRespond: 100,
        src: 'client',
        width: 300,
        height: 250
      };

      mediagoAnalytics.track({eventType: BID_WON, args: bidArgs});
      clock.tick(100);

      sinon.assert.calledOnce(ajaxStub);
      const callArgs = ajaxStub.getCall(0).args;
      const data = JSON.parse(callArgs[2]);
      const event = data[0];

      expect(event.logType).to.equal('prebid');
      expect(event.evt).to.equal('bidWon');
      expect(event.from).to.equal(2);
      expect(typeof event.ua).to.equal('string');
      expect(event.auctionElapseTime).to.equal(500);
      expect(event.bidderRequests).to.exist;
      expect(Array.isArray(event.bidderRequests)).to.be.true;
      expect(event.bidderRequests.length).to.equal(1);
      expect(event.bidderRequests[0].bids).to.exist;
      expect(Array.isArray(event.bidderRequests[0].bids)).to.be.true;
      expect(event.bidderRequests[0].bids.length).to.equal(1);

      const bidRequest = event.bidderRequests[0].bids[0];
      expect(bidRequest.mmBid).to.exist;
      expect(bidRequest.mmBid.ext).to.exist;
      expect(typeof bidRequest.mmBid.ext).to.equal('object');
      expect(Object.keys(bidRequest.mmBid.ext).length).to.equal(0);
      expect(bidRequest.mmBid.bidElapsedTime).to.equal(100);
      expect(bidRequest.mmBid.bidder).to.equal('pubmatic');
      expect(bidRequest.mmBid.slotid).to.equal('div-1');
      expect(bidRequest.mmBid.bidderSource).to.equal('client');
    });

    it('should remove sensitive bid fields (ad, adUrl, vastXML)', () => {
      const bidArgs = {
        auctionId: 'auction-123',
        timestamp: 1500,
        bidderCode: 'pubmatic',
        adId: 'ad-123',
        cpm: 2.5,
        adUnitCode: 'div-1',
        ad: '<div>ad content</div>',
        adUrl: 'https://example.com/ad',
        vastXML: '<VAST>...</VAST>'
      };

      mediagoAnalytics.track({eventType: BID_WON, args: bidArgs});
      clock.tick(100);

      sinon.assert.calledOnce(ajaxStub);
      const callArgs = ajaxStub.getCall(0).args;
      const data = JSON.parse(callArgs[2]);
      const event = data[0];
      const mmBid = event.bidderRequests[0].bids[0].mmBid;

      expect(mmBid.hasOwnProperty('ad')).to.be.false;
      expect(mmBid.hasOwnProperty('adUrl')).to.be.false;
      expect(mmBid.hasOwnProperty('vastXML')).to.be.false;
    });

    it('should use bidderCode as bidder, fallback to bidder field', () => {
      const bidArgs1 = {
        auctionId: 'auction-123',
        timestamp: 1500,
        bidderCode: 'pubmatic',
        adId: 'ad-123',
        cpm: 2.5,
        adUnitCode: 'div-1'
      };

      mediagoAnalytics.track({eventType: BID_WON, args: bidArgs1});
      clock.tick(100);

      sinon.assert.calledOnce(ajaxStub);
      const callArgs1 = ajaxStub.getCall(0).args;
      const data1 = JSON.parse(callArgs1[2]);
      expect(data1[0].bidderRequests[0].bids[0].mmBid.bidder).to.equal('pubmatic');

      ajaxStub.resetHistory();

      const bidArgs2 = {
        auctionId: 'auction-123',
        timestamp: 1500,
        bidder: 'appnexus', // No bidderCode
        adId: 'ad-123',
        cpm: 2.5,
        adUnitCode: 'div-1'
      };

      mediagoAnalytics.track({eventType: BID_WON, args: bidArgs2});
      clock.tick(100);

      sinon.assert.calledOnce(ajaxStub);
      const callArgs2 = ajaxStub.getCall(0).args;
      const data2 = JSON.parse(callArgs2[2]);
      expect(data2[0].bidderRequests[0].bids[0].mmBid.bidder).to.equal('appnexus');
    });

    it('should calculate auctionElapseTime correctly', () => {
      const bidArgs = {
        auctionId: 'auction-123',
        timestamp: 2500, // 1500ms after auctionInit (1000)
        bidderCode: 'pubmatic',
        adId: 'ad-123',
        cpm: 2.5,
        adUnitCode: 'div-1'
      };

      mediagoAnalytics.track({eventType: BID_WON, args: bidArgs});
      clock.tick(100);

      sinon.assert.calledOnce(ajaxStub);
      const callArgs = ajaxStub.getCall(0).args;
      const data = JSON.parse(callArgs[2]);
      expect(data[0].auctionElapseTime).to.equal(1500); // 2500 - 1000
    });
  });

  describe('Data Processing', () => {
    beforeEach(() => {
      mediagoAnalytics.enableAnalytics({
        provider: 'mediago',
        options: {
          batchSize: 1
        }
      });
    });

    it('should include User Agent in all events', () => {
      const ua = navigator.userAgent;

      mediagoAnalytics.track({
        eventType: BID_WON,
        args: {
          auctionId: 'test',
          timestamp: 1000,
          requestId: 'req-1',
          bidderCode: 'test',
          adId: 'ad-1',
          cpm: 2.5,
          adUnitCode: 'div-1'
        }
      });
      clock.tick(100);

      sinon.assert.calledOnce(ajaxStub);
      const callArgs = ajaxStub.getCall(0).args;
      const data = JSON.parse(callArgs[2]);
      expect(data[0].ua).to.equal(ua);
    });

    it('should set logType to "prebid" for all events', () => {
      mediagoAnalytics.track({
        eventType: BID_WON,
        args: {
          auctionId: 'test',
          timestamp: 1000,
          requestId: 'req-1',
          bidderCode: 'test',
          adId: 'ad-1',
          cpm: 2.5,
          adUnitCode: 'div-1'
        }
      });
      clock.tick(100);

      sinon.assert.calledOnce(ajaxStub);
      const callArgs = ajaxStub.getCall(0).args;
      const data = JSON.parse(callArgs[2]);
      expect(data[0].logType).to.equal('prebid');
    });

    it('should set from to 2 for all events', () => {
      mediagoAnalytics.track({
        eventType: BID_WON,
        args: {
          auctionId: 'test',
          timestamp: 1000,
          requestId: 'req-1',
          bidderCode: 'test',
          adId: 'ad-1',
          cpm: 2.5,
          adUnitCode: 'div-1'
        }
      });
      clock.tick(100);

      sinon.assert.calledOnce(ajaxStub);
      const callArgs = ajaxStub.getCall(0).args;
      const data = JSON.parse(callArgs[2]);
      expect(data[0].from).to.equal(2);
    });
  });

  describe('Default Endpoint', () => {
    it('should use MediagoAnalyticsEP as default endpoint', () => {
      mediagoAnalytics.enableAnalytics({
        provider: 'mediago',
        options: {
          batchSize: 1
        }
      });

      mediagoAnalytics.track({
        eventType: BID_WON,
        args: {
          auctionId: 'test',
          timestamp: 1000,
          requestId: 'req-1',
          bidderCode: 'test',
          adId: 'ad-1',
          cpm: 2.5,
          adUnitCode: 'div-1'
        }
      });
      clock.tick(100);

      sinon.assert.calledOnce(ajaxStub);
      sinon.assert.calledWith(ajaxStub, MediagoAnalyticsEP, sinon.match.any, sinon.match.any, sinon.match.any);
    });
  });

  describe('Batch Processing', () => {
    it('should respect batchSize configuration', () => {
      mediagoAnalytics.enableAnalytics({
        provider: 'mediago',
        options: {
          batchSize: 2
        }
      });

      mediagoAnalytics.track({
        eventType: BID_WON,
        args: {
          auctionId: '1',
          timestamp: 1000,
          requestId: 'req-1',
          bidderCode: 'test',
          adId: 'ad-1',
          cpm: 2.5,
          adUnitCode: 'div-1'
        }
      });
      sinon.assert.notCalled(ajaxStub);

      mediagoAnalytics.track({
        eventType: BID_WON,
        args: {
          auctionId: '2',
          timestamp: 2000,
          requestId: 'req-2',
          bidderCode: 'test',
          adId: 'ad-2',
          cpm: 2.5,
          adUnitCode: 'div-2'
        }
      });
      sinon.assert.calledOnce(ajaxStub);

      const callArgs = ajaxStub.getCall(0).args;
      const data = JSON.parse(callArgs[2]);
      expect(data.length).to.equal(2);
    });

    it('should respect batchDelay configuration', () => {
      mediagoAnalytics.enableAnalytics({
        provider: 'mediago',
        options: {
          batchSize: 10,
          batchDelay: 200
        }
      });

      mediagoAnalytics.track({
        eventType: BID_WON,
        args: {
          auctionId: '1',
          timestamp: 1000,
          requestId: 'req-1',
          bidderCode: 'test',
          adId: 'ad-1',
          cpm: 2.5,
          adUnitCode: 'div-1'
        }
      });
      sinon.assert.notCalled(ajaxStub);

      clock.tick(100);
      sinon.assert.notCalled(ajaxStub);

      clock.tick(100);
      sinon.assert.calledOnce(ajaxStub);
    });
  });

  describe('HTTP Method', () => {
    it('should use POST method by default', () => {
      mediagoAnalytics.enableAnalytics({
        provider: 'mediago',
        options: {
          batchSize: 1
        }
      });

      mediagoAnalytics.track({
        eventType: BID_WON,
        args: {
          auctionId: 'test',
          timestamp: 1000,
          requestId: 'req-1',
          bidderCode: 'test',
          adId: 'ad-1',
          cpm: 2.5,
          adUnitCode: 'div-1'
        }
      });
      clock.tick(100);

      sinon.assert.calledOnce(ajaxStub);
      const callArgs = ajaxStub.getCall(0).args;
      const options = callArgs[3];
      expect(options.method).to.equal('POST');
    });

    it('should allow custom HTTP method', () => {
      mediagoAnalytics.enableAnalytics({
        provider: 'mediago',
        options: {
          batchSize: 1,
          method: 'GET'
        }
      });

      mediagoAnalytics.track({
        eventType: BID_WON,
        args: {
          auctionId: 'test',
          timestamp: 1000,
          requestId: 'req-1',
          bidderCode: 'test',
          adId: 'ad-1',
          cpm: 2.5,
          adUnitCode: 'div-1'
        }
      });
      clock.tick(100);

      sinon.assert.calledOnce(ajaxStub);
      const callArgs = ajaxStub.getCall(0).args;
      const options = callArgs[3];
      expect(options.method).to.equal('GET');
    });
  });

  describe('disableAnalytics', () => {
    it('should send remaining events when disabled', () => {
      mediagoAnalytics.enableAnalytics({
        provider: 'mediago',
        options: {
          batchSize: 10,
          batchDelay: 1000
        }
      });

      mediagoAnalytics.track({
        eventType: BID_WON,
        args: {
          auctionId: '1',
          timestamp: 1000,
          requestId: 'req-1',
          bidderCode: 'test',
          adId: 'ad-1',
          cpm: 2.5,
          adUnitCode: 'div-1'
        }
      });
      sinon.assert.notCalled(ajaxStub);

      mediagoAnalytics.disableAnalytics();
      sinon.assert.calledOnce(ajaxStub);

      const callArgs = ajaxStub.getCall(0).args;
      const data = JSON.parse(callArgs[2]);
      expect(data.length).to.equal(1);
    });
  });
});
