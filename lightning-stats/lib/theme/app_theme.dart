import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

/// Colors lifted from app/globals.css so the Android app matches the website.
class AppColors {
  AppColors._();

  static const background = Color(0xFF0A0A0F);
  static const surface = Color(0xF006060E); // rgba(6,6,14,0.92)
  static const surfaceRaised = Color(0x0FFFFFFF); // rgba(255,255,255,0.06)
  static const border = Color(0x26FFFFFF); // rgba(255,255,255,0.15)

  static const accent = Color(0xFFFFE040); // bright yellow
  static const accentDim = Color(0xCCFFDC00); // rgba(255,220,0,0.8)
  static const accentBorder = Color(0x4DFFDC00); // rgba(255,220,0,0.3)

  static const textPrimary = Color(0xFFEDEDED);
  static const textSecondary = Color(0xFFA0A0AC);

  // Strike age gradient (bright yellow -> orange -> red -> dark purple).
  static const strikeFresh = Color(0xFFFFF176);
  static const strikeMid = Color(0xFFFF6D28);
  static const strikeOld = Color(0xFFD32F2F);
  static const strikeAncient = Color(0xFF4A148C);
}

ThemeData buildAppTheme() {
  final base = ThemeData.dark(useMaterial3: true);
  final textTheme = GoogleFonts.jetBrainsMonoTextTheme(base.textTheme).apply(
    bodyColor: AppColors.textPrimary,
    displayColor: AppColors.textPrimary,
  );

  return base.copyWith(
    scaffoldBackgroundColor: AppColors.background,
    textTheme: textTheme,
    colorScheme: base.colorScheme.copyWith(
      primary: AppColors.accent,
      secondary: AppColors.accent,
      surface: AppColors.background,
    ),
    appBarTheme: AppBarTheme(
      backgroundColor: AppColors.surface,
      elevation: 0,
      surfaceTintColor: Colors.transparent,
      titleTextStyle: textTheme.titleMedium?.copyWith(
        color: AppColors.accentDim,
        fontWeight: FontWeight.w700,
        letterSpacing: 1.2,
      ),
      iconTheme: const IconThemeData(color: AppColors.accentDim),
    ),
    navigationBarTheme: NavigationBarThemeData(
      backgroundColor: AppColors.surface,
      indicatorColor: AppColors.accent.withValues(alpha: 0.15),
      labelTextStyle: WidgetStateProperty.resolveWith((states) {
        final selected = states.contains(WidgetState.selected);
        return textTheme.labelSmall?.copyWith(
          color: selected ? AppColors.accent : AppColors.textSecondary,
          fontWeight: FontWeight.w700,
          letterSpacing: 0.6,
        );
      }),
      iconTheme: WidgetStateProperty.resolveWith((states) {
        final selected = states.contains(WidgetState.selected);
        return IconThemeData(color: selected ? AppColors.accent : AppColors.textSecondary);
      }),
    ),
    dividerColor: AppColors.border,
    cardTheme: const CardThemeData(
      color: AppColors.surfaceRaised,
      elevation: 0,
    ),
    listTileTheme: const ListTileThemeData(
      textColor: AppColors.textPrimary,
      iconColor: AppColors.accentDim,
      contentPadding: EdgeInsets.symmetric(horizontal: 20, vertical: 14),
      minVerticalPadding: 14,
    ),
    visualDensity: VisualDensity.comfortable,
    switchTheme: SwitchThemeData(
      thumbColor: WidgetStateProperty.resolveWith(
        (states) => states.contains(WidgetState.selected) ? AppColors.accent : AppColors.textSecondary,
      ),
      trackColor: WidgetStateProperty.resolveWith(
        (states) => states.contains(WidgetState.selected)
            ? AppColors.accent.withValues(alpha: 0.4)
            : AppColors.surfaceRaised,
      ),
    ),
  );
}
