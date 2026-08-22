import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../l10n/app_strings.dart';
import '../services/settings_controller.dart';
import '../theme/app_theme.dart';

const Map<String, String> _localeFlags = {'en': 'gb', 'nl': 'nl', 'de': 'de', 'fr': 'fr', 'es': 'es'};

void showSettingsSheet(BuildContext context) {
  showModalBottomSheet(
    context: context,
    backgroundColor: AppColors.surface,
    isScrollControlled: true,
    shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(20))),
    builder: (_) => const _SettingsSheet(),
  );
}

class _SettingsSheet extends StatelessWidget {
  const _SettingsSheet();

  @override
  Widget build(BuildContext context) {
    final s = context.watch<SettingsController>();
    final t = AppStrings.of(context);
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(24, 28, 24, 32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(t.t('nav.settings'),
                style: const TextStyle(color: AppColors.accent, fontWeight: FontWeight.bold, fontSize: 20)),
            const SizedBox(height: 20),
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              title: Text(t.t('nav.sound'), style: const TextStyle(color: AppColors.textPrimary, fontSize: 17)),
              value: s.sound,
              onChanged: (_) => s.toggleSound(),
            ),
            const SizedBox(height: 24),
            Wrap(
              spacing: 12,
              runSpacing: 12,
              children: kSupportedLocales.map((l) {
                final active = s.locale == l;
                return ChoiceChip(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
                  label: Text(l.toUpperCase(), style: const TextStyle(fontSize: 15)),
                  avatar: ClipOval(
                    child: Image.network('https://flagcdn.com/w20/${_localeFlags[l]}.png', width: 18, height: 18, fit: BoxFit.cover),
                  ),
                  selected: active,
                  onSelected: (_) => s.setLocale(l),
                  selectedColor: AppColors.accent.withValues(alpha: 0.25),
                  labelStyle: TextStyle(color: active ? AppColors.accent : AppColors.textSecondary),
                );
              }).toList(),
            ),
          ],
        ),
      ),
    );
  }
}
