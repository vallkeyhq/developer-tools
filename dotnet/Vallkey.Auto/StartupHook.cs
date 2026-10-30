// DOTNET_STARTUP_HOOKS=/path/to/Vallkey.Auto.dll: the runtime calls Initialize() before
// the app's own Main, so no code in the app changes. VALLKEY_AUTO=0 turns it off.
internal class StartupHook
{
    public static void Initialize()
    {
        if (System.Environment.GetEnvironmentVariable("VALLKEY_AUTO") != "0") Vallkey.Auto.Hook.Install();
    }
}
