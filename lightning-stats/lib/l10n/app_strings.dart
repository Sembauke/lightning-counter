import 'package:flutter/widgets.dart';
import 'package:provider/provider.dart';

import '../services/settings_controller.dart';
import '../utils/format.dart';
import 'messages.dart';

/// French cardinal plurals treat 0 *and* 1 as "one" (CLDR rule); the other
/// four supported locales only treat 1 as "one".
bool _isOne(String locale, num count) => locale == 'fr' ? (count == 0 || count == 1) : count == 1;

/// Lightweight stand-in for next-intl's useTranslations(): flat "ns.key"
/// lookups with {placeholder} interpolation and a minimal ICU-plural resolver
/// (only the "{count, plural, one {...} other {...}}" shape used by messages/*.json).
class AppStrings {
  final String locale;
  const AppStrings(this.locale);

  static AppStrings of(BuildContext context) {
    final locale = context.watch<SettingsController>().locale;
    return AppStrings(locale);
  }

  String _raw(String key) => kMessages[locale]?[key] ?? kMessages['en']?[key] ?? key;

  String t(String key, [Map<String, Object>? args]) {
    var s = _raw(key);
    if (args != null) {
      for (final entry in args.entries) {
        s = s.replaceAll('{${entry.key}}', '${entry.value}');
      }
    }
    return s;
  }

  String plural(String key, int count, [Map<String, Object>? args]) {
    final template = _raw(key);
    final match = RegExp(r'one \{([^}]*)\} other \{([^}]*)\}').firstMatch(template);
    if (match == null) return t(key, {'count': count, ...?args});
    final branch = _isOne(locale, count) ? match.group(1)! : match.group(2)!;
    // ICU plural "#" is number-formatted (matches next-intl/ICU MessageFormat
    // default) — unlike plain {placeholder} interpolation, which isn't.
    var s = branch.replaceAll('#', fmt(count));
    if (args != null) {
      for (final entry in args.entries) {
        s = s.replaceAll('{${entry.key}}', '${entry.value}');
      }
    }
    return s;
  }
}
