import { deriveAdtUrl, parseServer } from '../../../lib/landscape/adtUrl';

describe('adtUrl derivation', () => {
  describe('parseServer', () => {
    it('parses host and port correctly', () => {
      const res = parseServer('s4dev.example.com:3200');
      expect(res).toEqual({
        host: 's4dev.example.com',
        port: '3200',
        instance: '00',
      });
    });

    it('parses bracketed IPv6 and port correctly', () => {
      const res = parseServer('[2001:db8::1]:3201');
      expect(res).toEqual({
        host: '[2001:db8::1]',
        port: '3201',
        instance: '01',
      });
    });

    it('handles missing port', () => {
      const res = parseServer('s4dev.example.com');
      expect(res).toEqual({
        host: 's4dev.example.com',
        port: null,
        instance: '',
        error: 'no_port',
      });
    });

    it('handles unexpected port', () => {
      const res = parseServer('s4dev.example.com:8000');
      expect(res).toEqual({
        host: 's4dev.example.com',
        port: '8000',
        instance: '',
      });
    });

    it('handles unparseable or empty server strings', () => {
      expect(parseServer('')).toEqual({
        host: null,
        port: null,
        instance: '',
        error: 'unparsed_server',
      });
      expect(parseServer(':::')).toEqual({
        host: null,
        port: null,
        instance: '',
        error: 'unparsed_server',
      });
    });
  });

  describe('deriveAdtUrl', () => {
    it('derives https URL with port 443NN from port 32NN', () => {
      const res = deriveAdtUrl('s4dev.corp:3200');
      expect(res).toEqual({
        proposed_url: 'https://s4dev.corp:44300',
        url_source: 'derived',
        url_reason: null,
      });
    });

    it('derives https URL with bracketed IPv6 and port 443NN', () => {
      const res = deriveAdtUrl('[2001:db8::1]:3215');
      expect(res).toEqual({
        proposed_url: 'https://[2001:db8::1]:44315',
        url_source: 'derived',
        url_reason: null,
      });
    });

    it('returns null and no_port reason when server has no port', () => {
      const res = deriveAdtUrl('s4dev.corp');
      expect(res).toEqual({
        proposed_url: null,
        url_source: 'derived',
        url_reason: 'no_port',
      });
    });

    it('returns null and unexpected_port reason when port does not match 32NN', () => {
      const res = deriveAdtUrl('s4dev.corp:8000');
      expect(res).toEqual({
        proposed_url: null,
        url_source: 'derived',
        url_reason: 'unexpected_port',
      });
    });

    it('returns null and unparsed_server reason when server string cannot be parsed', () => {
      const res = deriveAdtUrl('   ');
      expect(res).toEqual({
        proposed_url: null,
        url_source: 'derived',
        url_reason: 'unparsed_server',
      });
    });

    it('preserves explicit URL overrides when passed', () => {
      const res = deriveAdtUrl(
        's4dev.corp:3200',
        'https://custom-adt.corp:8443',
      );
      expect(res).toEqual({
        proposed_url: 'https://custom-adt.corp:8443',
        url_source: 'explicit',
        url_reason: null,
      });
    });
  });
});
