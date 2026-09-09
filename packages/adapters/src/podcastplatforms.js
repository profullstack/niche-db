/**
 * Which hosts are podcast platforms, and which are somebody's own domain.
 *
 * A podcast feed sits in one of two places: on a service that hosts thousands
 * of shows, or on the domain of the show itself. That is the only structural
 * distinction in the medium a reader can act on. It separates the shows with a
 * company behind them from the ones a person publishes, and it is the split
 * neither Apple nor Spotify will draw for you, because both are in the first
 * group's business.
 *
 * Nothing in a feed declares which it is, so it is measured. These are the 307
 * registrable domains carrying 25 or more feeds that were live in the Podcast
 * Index bulk dump of 2026-08-23: HTTP 200 on the last crawl, and an episode
 * inside 90 days. Together they hold 395,690 of the 421,928 live feeds, 93.8%.
 * The remainder, spread across roughly 13,400 domains, is the self-hosted half.
 *
 * WHY A COUNT AND NOT A CURATED LIST
 *
 * A hand-written list of "the podcast hosts" is a list of the ones you have
 * heard of, and the long tail here is German church networks, Japanese radio
 * stations and Czech public broadcasters. Counting finds those; memory does
 * not. The threshold is deliberately the same one p0dcasters draws its indie
 * cut at, so a show classified there and a show classified here cannot
 * disagree.
 *
 * TWO THINGS THE COUNT GETS WRONG, KNOWINGLY
 *
 * - A broadcaster's own domain lands in the platform group. abc.net.au,
 *   npr.org and files.bbci.co.uk each carry over a hundred shows, so the count
 *   files them here. For the purpose of the split that is right, since those
 *   shows do have a company behind them, but it is not "hosting platform" in
 *   the narrow sense and it is worth knowing before quoting the group.
 * - Generic infrastructure is in it too: wordpress.com, squarespace.com,
 *   github.io, amazonaws.com, cloudfront.net, r2.dev. A show on an S3 bucket is
 *   self-published in every sense except the domain it answers on. Nothing in
 *   the URL can tell that apart from a managed service, so they stay in the
 *   platform group and this comment says so.
 *
 * THE ONE THING THAT WOULD HAVE BROKEN IT
 *
 * The Podcast Index `host` column sometimes holds a bare public suffix --
 * `co.uk`, `com.br`, `org.au`, `com.au`, `org.uk` -- instead of the registrable
 * domain, and every one of those cleared the 25-feed threshold. Left in, the
 * suffix match below would have filed every .co.uk podcast in the country as
 * commercially hosted. They are removed. That costs 453 feeds whose real host
 * is unknown, and sending them to the self-hosted side is the safe error: this
 * split exists to find the independent shows, so the failure mode to avoid is
 * the one that hides them.
 */

/** Registrable domains that host other people's shows. Measured, see above. */
export const PLATFORM_HOSTS = new Set([
  'anchor.fm', // 97,805
  'buzzsprout.com', // 46,927
  'spreaker.com', // 41,428
  'podbean.com', // 22,542
  'rss.com', // 16,655
  'libsyn.com', // 15,377
  'acast.com', // 10,951
  'transistor.fm', // 9,701
  'megaphone.fm', // 8,890
  'captivate.fm', // 8,295
  'soundcloud.com', // 8,051
  'podigee.io', // 7,110
  'omnycontent.com', // 6,441
  'simplecast.com', // 5,854
  'substack.com', // 5,022
  'ivoox.com', // 4,943
  'riverside.fm', // 4,619
  'riverside.com', // 4,553
  'redcircle.com', // 3,880
  'ausha.co', // 3,591
  'firstory.me', // 3,365
  'feedburner.com', // 3,177
  'soundon.fm', // 2,878
  'xyzfm.space', // 2,694
  'subsplash.com', // 2,271
  'audiomeans.fr', // 2,197
  'mave.digital', // 1,710
  'ximalaya.com', // 1,632
  'castos.com', // 1,555
  'podcaster.de', // 1,433
  'art19.com', // 1,358
  'podomatic.com', // 1,174
  'audioboom.com', // 1,150
  'stand.fm', // 1,136
  'letscast.fm', // 1,085
  'blubrry.com', // 1,003
  'kajabi.com', // 972
  'amperwave.net', // 928
  'radiofrance-podcast.net', // 883
  'pinecast.com', // 637
  'fastcast.ai', // 556
  'hearthis.at', // 556
  'squarespace.com', // 552
  'zencastr.com', // 536
  'fexingo.com', // 485
  'fireside.fm', // 470
  'pod.space', // 439
  'podcastics.com', // 439
  'casti.fyi', // 418
  'podserve.fm', // 411
  'alitu.com', // 406
  'sermon.net', // 400
  'iono.fm', // 398
  'pdrl.fm', // 396
  'streamguys1.com', // 380
  'prisasd.com', // 372
  'castbox.fm', // 368
  'pod.co', // 365
  'wavlake.com', // 328
  'promodj.com', // 327
  'async.com', // 322
  'cdnstream1.com', // 318
  'patreon.com', // 313
  'lepodcast.fr', // 303
  'octopus.saooti.com', // 297
  'sermonaudio.com', // 297
  'flightcast.com', // 295
  'granicus.com', // 289
  'rfi.fr', // 285
  'rtve.es', // 283
  'podplaystudio.com', // 266
  'springcast.fm', // 264
  'sonicbowl.cloud', // 258
  'files.bbci.co.uk', // 256
  'mujrozhlas.cz', // 254
  'podster.fm', // 254
  'podeo.co', // 253
  'planningcenteronline.com', // 246
  'beehiiv.com', // 242
  'rdl.de', // 236
  'hubhopper.com', // 234
  'blubrry.net', // 231
  'feedpress.me', // 224
  'publicfeeds.net', // 215
  'logos.com', // 198
  'prestocast.com', // 194
  'stvr.sk', // 189
  'jellypod.com', // 188
  'beatlinesports.com', // 179
  'julephosting.de', // 178
  'audiorella.com', // 177
  'autopod.xyz', // 176
  'robotstart.jp', // 176
  'podpoint.com', // 175
  'podetize.com', // 172
  'helloaudio.fm', // 163
  'oneplace.com', // 163
  'wistia.com', // 163
  'futurimedia.com', // 160
  'github.io', // 158
  'srf.ch', // 155
  'nrjaudio.fm', // 150
  'rtvslo.si', // 139
  'sbs.com.au', // 139
  'zencast.fm', // 137
  'cohostpodcasting.com', // 135
  'lizhi.fm', // 135
  'listen.style', // 128
  'podhome.fm', // 125
  'seesaa.net', // 125
  'nucleus.church', // 123
  'sr.se', // 123
  'npo.nl', // 122
  'podcastle.ai', // 122
  'radiomaria.es', // 119
  'rtv.rs', // 118
  'godcaster.fm', // 117
  'radiotalk.jp', // 114
  'enacastapis.com', // 112
  'abc.net.au', // 111
  'wdr.de', // 110
  'omny.fm', // 108
  'springcast.app', // 107
  'orf.at', // 105
  'france24.com', // 102
  'ndr.de', // 102
  'paris2tokyo.com', // 100
  'vodio.fr', // 100
  'pippa.io', // 99
  'oneofus.net', // 94
  'podcastmirror.com', // 93
  'kerkomroep.nl', // 91
  'odysee.com', // 90
  'err.ee', // 89
  'fountain.fm', // 88
  'tilos.hu', // 87
  'mp3mp4pdf.net', // 86
  'dr.dk', // 84
  'globoradio.globo.com', // 84
  '3cat.cat', // 83
  'americaoutloud.news', // 82
  'civicmedia.us', // 82
  'r2.dev', // 81
  'ilsole24ore.com', // 79
  'thechurchco.site', // 79
  'arteradio.com', // 78
  'br.de', // 78
  'radiopopolare.it', // 78
  'lightcast.com', // 77
  'meinpodcast.de', // 76
  'stream.schibsted.media', // 76
  'usp.br', // 76
  'lsm.lv', // 75
  'polskieradio.pl', // 75
  'supabase.co', // 75
  'deutschlandfunk.de', // 74
  'mdstrm.com', // 73
  'kboo.fm', // 72
  'radionikkei.jp', // 72
  'baladoquebec.ca', // 71
  'wordpress.com', // 71
  'cba.media', // 69
  'discerninghearts.com', // 68
  'amazonaws.com', // 66
  'cbc.ca', // 66
  'doctorpodcasting.com', // 66
  'jewishpodcasts.fm', // 66
  'podengine.io', // 66
  'boxcast.com', // 65
  'ewtn.com', // 65
  'vaticannews.va', // 64
  'podcasty.seznam.cz', // 63
  'zenomedia.com', // 62
  'blurt.media', // 61
  'freie-radios.net', // 60
  'resonaterecordings.com', // 59
  'djpod.com', // 57
  'securenetsystems.net', // 57
  'bbsradio.com', // 56
  'fame.so', // 56
  'fusebox.fm', // 56
  'midilibre.fr', // 56
  'podtoo.com', // 56
  'spheraholding.net', // 56
  'lsmradio.com', // 55
  'podpilot.org', // 54
  'radiorcj.info', // 54
  'sudradio.fr', // 54
  'talkshoe.com', // 53
  'dw.com', // 52
  'rti.org.tw', // 52
  'vigilante.tv', // 51
  '360.audion.fm', // 50
  '3cr.org.au', // 50
  'accessmedia.nz', // 50
  'ognjisce.si', // 50
  'uctv.tv', // 50
  'ancientfaith.com', // 49
  'audioteca.rac1.cat', // 49
  'cism893.ca', // 49
  'radiocampusparis.org', // 49
  'podcasts.com', // 48
  'rnz.co.nz', // 48
  'swr.de', // 47
  'interactvty.com', // 46
  'ladepeche.fr', // 46
  'meinsportpodcast.de', // 46
  'barstoolsports.com', // 45
  'dharmaseed.org', // 45
  'mdr.de', // 45
  'ondacero.es', // 45
  'businessradiox.com', // 44
  'lesonunique.com', // 44
  'introcast.io', // 43
  'proxy.wavpub.com', // 43
  'retro-otr.com', // 43
  'stationista.com', // 43
  'tonyfunderburk.com', // 43
  'cloudfront.net', // 42
  'googleapis.com', // 42
  'imbc.com', // 42
  'radiopresence.com', // 42
  'republicbroadcastingarchives.org', // 42
  'kanalk.ch', // 41
  'pwtorch.com', // 41
  'thisisdistorted.com', // 41
  'eshelpublications.com', // 40
  'npr.org', // 40
  'radioalpa.com', // 40
  'yutorah.org', // 40
  'nyc3.digitaloceanspaces.com', // 39
  'altitudefm.com', // 38
  'lahr.mx', // 38
  'postimees.ee', // 38
  'bramfm.com', // 37
  'vrt.be', // 37
  'beamly.com', // 36
  'chabad.org', // 36
  'deutschlandfunkkultur.de', // 36
  'dvidshub.net', // 36
  'financiallytuned.com', // 36
  'kpfa.org', // 36
  'newsramp.net', // 36
  'rte.ie', // 36
  'asfpodcast.org', // 35
  'chaifm.com', // 35
  'passiontimes.hk', // 35
  'radiolarzac.org', // 35
  'radiopodcast.unam.mx', // 35
  'radioradicale.it', // 35
  'twit.tv', // 35
  'yetanothersermon.host', // 35
  'hakkaradio.org.tw', // 34
  'kbs.co.kr', // 34
  'lightsource.com', // 34
  'radio1.ch', // 33
  'alivepodcastnetwork.com', // 32
  'apps.education.fr', // 32
  'cgtn.com', // 32
  'hr.de', // 32
  'justcast.com', // 32
  'klubradio.hu', // 32
  'ondarossa.info', // 32
  'radiolaser.fr', // 32
  'radiopopular.com', // 32
  'sbs.co.kr', // 32
  'youtube.com', // 32
  'la-bas.org', // 30
  'martinoticias.com', // 30
  'primeralecturaediciones.com', // 30
  'accent4.com', // 29
  'afr.net', // 29
  'cope.es', // 29
  'hubbardpodcasts.com', // 29
  'radio.cz', // 29
  'radiodynamo.org', // 29
  'rmf.pl', // 29
  'rtl.lu', // 29
  'typlog.io', // 29
  'afripods.com', // 28
  'blob.core.windows.net', // 28
  'cast.rocks', // 28
  'libertaddigital.com', // 28
  'podcastai.com', // 28
  'radio7.cz', // 28
  'wavpub.com', // 28
  'xray.fm', // 28
  'adventistchurch.org', // 27
  'christianworldmedia.com', // 27
  'disctopia.com', // 27
  'nrk.no', // 27
  'podcastdemedicina.com', // 27
  'radio-activ.com', // 27
  'redbasset.tech', // 27
  'dropwave.io', // 26
  'lumen.sk', // 26
  'notisistema.net', // 26
  'nrwision.de', // 26
  'qingting.fm', // 26
  'fairlatterdaysaints.org', // 25
  'mc-doualiya.com', // 25
  'meinmusikpodcast.de', // 25
  'mypodops.com', // 25
  'nbcnews.com', // 25
  'publicradio.org', // 25
  'radioslibresenperigord.com', // 25
  'rts.ch', // 25
]);

/**
 * Which platform serves this feed, or null if the show serves it itself.
 *
 * Matched on the suffix, not on equality: a show's feed is at
 * `feeds.buzzsprout.com/123.rss` far more often than at the bare domain, and
 * most of the set above is only ever reached through a subdomain. The leading
 * dot is what keeps `notbuzzsprout.com` out of it.
 *
 * It returns the platform rather than a boolean because the hostname is not a
 * usable name for one. A show on S3 answers at
 * `some-show-media.s3.us-east-1.amazonaws.com`, which is as unique as the show
 * is; the platform is `amazonaws.com`, which is the thing there are 66 of and
 * the thing worth grouping by.
 *
 * A URL that will not parse belongs to nobody, and is reported as no platform,
 * so it lands in the self-hosted group. That is the same direction the
 * public-suffix removal errs in, for the same reason.
 *
 * @param {string} feedUrl
 * @returns {string|null}
 */
export function platformOf(feedUrl) {
  let host;
  try {
    host = new URL(String(feedUrl)).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
  if (PLATFORM_HOSTS.has(host)) return host;
  for (const platform of PLATFORM_HOSTS) {
    if (host.endsWith(`.${platform}`)) return platform;
  }
  return null;
}

/**
 * Is this feed URL served by a platform rather than by the show itself?
 *
 * @param {string} feedUrl
 * @returns {boolean}
 */
export function isPlatformHosted(feedUrl) {
  return platformOf(feedUrl) !== null;
}
