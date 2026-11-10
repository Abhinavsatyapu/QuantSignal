'use strict';
// SEC EDGAR Form 4 / 13D-G / 13F compact helpers. User-Agent must include a name + email.

function xmlSections(xml, tag) {
  const re = new RegExp(`<(?:[\\w.-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${tag}>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

function xmlText(xml, tag) {
  if (!xml) return null;
  const re = new RegExp(`<(?:[\\w.-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${tag}>`, 'i');
  const m = String(xml).match(re);
  if (!m) return null;
  const inner = m[1];
  const v = inner.match(/<value[^>]*>([\s\S]*?)<\/value>/i);
  if (v) return v[1].trim();
  const stripped = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return stripped || null;
}

function parseForm4(xml) {
  const owners = xmlSections(xml, 'reportingOwner').map((own) => ({
    name: xmlText(own, 'rptOwnerName'),
    cik: xmlText(own, 'rptOwnerCik'),
    isOfficer: xmlText(own, 'isOfficer'),
    isDirector: xmlText(own, 'isDirector'),
    isTenPercentOwner: xmlText(own, 'isTenPercentOwner'),
    officerTitle: xmlText(own, 'officerTitle'),
  }));
  const txns = [];
  for (const table of ['nonDerivativeTable', 'derivativeTable']) {
    const body = xmlSections(xml, table)[0] || '';
    for (const tr of xmlSections(body, 'nonDerivativeTransaction').concat(xmlSections(body, 'derivativeTransaction'))) {
      const rec = {
        table,
        security: xmlText(tr, 'securityTitle'),
        date: xmlText(tr, 'transactionDate'),
        code: xmlText(tr, 'transactionCode'),
        shares: xmlText(tr, 'transactionShares'),
        price: xmlText(tr, 'transactionPricePerShare'),
        acquiredOrDisposed: xmlText(tr, 'transactionAcquiredDisposedCode'),
        sharesAfter: xmlText(tr, 'sharesOwnedFollowingTransaction'),
      };
      if (rec.code) txns.push(rec);
    }
  }
  return {
    documentType: xmlText(xml, 'documentType'),
    periodOfReport: xmlText(xml, 'periodOfReport'),
    issuer: xmlText(xmlSections(xml, 'issuer')[0] || xml, 'issuerName'),
    ticker: xmlText(xmlSections(xml, 'issuer')[0] || xml, 'issuerTradingSymbol'),
    issuerCik: xmlText(xmlSections(xml, 'issuer')[0] || xml, 'issuerCik'),
    aff10b5One: xmlText(xml, 'aff10b5One'),
    owners,
    transactions: txns,
  };
}

function parse13dg(xml) {
  const first = (...tags) => {
    for (const t of tags) {
      const v = xmlText(xml, t);
      if (v) return v;
    }
    return null;
  };
  return {
    submissionType: first('submissionType'),
    amendmentNo: first('amendmentNo'),
    eventDate: first('eventDateRequiresFilingThisStatement'),
    issuerName: first('issuerName'),
    issuerCik: first('issuerCik'),
    issuerCusip: first('issuerCusipNumber'),
    securitiesClassTitle: first('securitiesClassTitle'),
    rule: first('designateRulePursuantThisScheduleFiled'),
    reportingPersonName: first('reportingPersonName'),
    soleVotingPower: first('soleVotingPower'),
    sharedVotingPower: first('sharedVotingPower'),
    soleDispositivePower: first('soleDispositivePower'),
    sharedDispositivePower: first('sharedDispositivePower'),
    aggregateShares: first('reportingPersonBeneficiallyOwnedAggregateNumberOfShares', 'aggregateAmount'),
    percentOfClass: first('percentOfClass', 'reportingPersonBeneficiallyOwnedPercentOfClass'),
  };
}

function matchesIssuer(parsed, { cik, cusip }) {
  const want = String(cik || '').replace(/^0+/, '');
  const got = String(parsed.issuerCik || '').replace(/^0+/, '');
  const cusipOk = cusip && String(parsed.issuerCusip || '').replace(/\s+/g, '') === String(cusip).replace(/\s+/g, '');
  return (!!want && got === want) || !!cusipOk;
}

function form4DocUrl(cik, accession, primary) {
  const acc = String(accession).replace(/-/g, '');
  const cikN = String(parseInt(String(cik), 10));
  let doc = (primary || 'form4.xml').split('/').pop();
  if (/^xslF345/i.test(doc)) {
    // EDGAR index sometimes prefixes the stylesheet; the raw XML drops that prefix path.
    const parts = String(primary || '').split('/');
    doc = parts[parts.length - 1].replace(/^xslF345X?\d+\//, '') || doc;
  }
  return `https://www.sec.gov/Archives/edgar/data/${cikN}/${acc}/${doc}`;
}

module.exports = { xmlText, xmlSections, parseForm4, parse13dg, matchesIssuer, form4DocUrl };
