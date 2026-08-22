import '../l10n/app_strings.dart';

/// Shared storm display-name logic used by Storms list/detail, Records, and
/// country-detail's biggest-storm card — ported from the repeated
/// `stormName`/`stormLabel` helpers in the web app's client components.
String stormLabel(AppStrings ts, {String? city, String? originCity, required String code, required double lat, required double lon}) {
  final isOcean = code == 'XO';
  final effCity = city ?? (isOcean ? 'Open Ocean' : null);
  final effOrigin = originCity ?? (isOcean ? 'Open Ocean' : null);
  if (effOrigin != null && effCity != null && effOrigin != effCity) {
    return ts.t('storms.stormFromTo', {'from': effOrigin, 'to': effCity});
  }
  if (effCity != null) return ts.t('storms.stormNear', {'city': effCity});
  return '${lat.toStringAsFixed(2)}, ${lon.toStringAsFixed(2)}';
}
