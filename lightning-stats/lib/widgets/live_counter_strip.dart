import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../services/live_counter_controller.dart';
import '../theme/app_theme.dart';
import '../utils/format.dart';

/// Persistent global strike counter + viewer count, shown under the app bar
/// on every screen (ports Navbar.tsx's always-visible StrikeCount strip).
class LiveCounterStrip extends StatelessWidget implements PreferredSizeWidget {
  const LiveCounterStrip({super.key});

  @override
  Size get preferredSize => const Size.fromHeight(40);

  @override
  Widget build(BuildContext context) {
    return Consumer<LiveCounterController>(
      builder: (context, counter, _) {
        return Container(
          height: preferredSize.height,
          color: AppColors.surface,
          padding: const EdgeInsets.symmetric(horizontal: 20),
          child: Row(
            children: [
              Container(
                width: 8,
                height: 8,
                margin: const EdgeInsets.only(right: 8),
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: counter.connected ? Colors.greenAccent : Colors.redAccent,
                ),
              ),
              Expanded(
                child: Text(
                  fmt(counter.display),
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(color: AppColors.accent, fontWeight: FontWeight.w700, fontSize: 15),
                ),
              ),
              if (counter.strikeRate > 0) ...[
                const SizedBox(width: 8),
                Text('${counter.strikeRate.toStringAsFixed(1)}/s',
                    style: const TextStyle(color: AppColors.textSecondary, fontSize: 13)),
              ],
              if (counter.viewers > 0) ...[
                const SizedBox(width: 14),
                const Icon(Icons.visibility_outlined, size: 14, color: AppColors.textSecondary),
                const SizedBox(width: 4),
                Text('${counter.viewers}', style: const TextStyle(color: AppColors.textSecondary, fontSize: 13)),
              ],
            ],
          ),
        );
      },
    );
  }
}
