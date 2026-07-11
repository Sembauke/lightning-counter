import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./i18n/request.ts');

export default withNextIntl({
  reactStrictMode: true,
  async redirects() {
    // The by-country page was merged into the discharge archive
    return [{ source: '/countries', destination: '/stats', permanent: true }];
  },
});
