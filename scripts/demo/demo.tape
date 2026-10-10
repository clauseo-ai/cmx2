# the terminal demo, played by scripts/demo/record.sh (which sets the DEMO_* variables and starts the daemon).
# tune the look here; nothing in this file calls a model.

Output "__OUT__"

Set Shell "bash"
Set FontFamily "Menlo"
Set FontSize 21
Set Width 1180
Set Height 560
Set Padding 30
Set LineHeight 1.25
Set TypingSpeed 40ms
Set Framerate 20
Set WindowBar Colorful
Set WindowBarSize 36
Set BorderRadius 14
Set Margin 24
Set MarginFill "#0d0b1f"
Set Theme { "name": "cmx2", "background": "#14112f", "foreground": "#f4f4f6", "cursor": "#8fe6a5", "selection": "#34298a", "black": "#14112f", "red": "#ff7a90", "green": "#8fe6a5", "yellow": "#ffb86b", "blue": "#b7abff", "magenta": "#d19bff", "cyan": "#7fd6e8", "white": "#f4f4f6", "brightBlack": "#6e6aa0", "brightRed": "#ff7a90", "brightGreen": "#8fe6a5", "brightYellow": "#ffb86b", "brightBlue": "#b7abff", "brightMagenta": "#d19bff", "brightCyan": "#7fd6e8", "brightWhite": "#ffffff" }

# set the scene off camera: a clean environment, the demo repo, a plain prompt
Hide
Type "exec env -i HOME=$DEMO_HOME PATH=$DEMO_BIN:$PATH LANG=en_US.UTF-8 TERM=xterm-256color CMX2_CONFIG_DIR=$DEMO_CONFIG CMX2_DATA_DIR=$DEMO_DATA PS1='$ ' bash --norc --noprofile"
Enter
Type "cd $DEMO_WORK && clear"
Enter
Sleep 600ms
Show

Sleep 500ms
Type 'cmx2 run "add a test for the parser"'
Sleep 400ms
Enter
Sleep 6s

# find the session this turn made (off camera), then show the agents it started
Hide
Type "ID=$(cmx2 session list | grep -v '(agent)' | head -1 | cut -d' ' -f1)"
Enter
Type "clear"
Enter
Sleep 300ms
Show
Type "cmx2 agent tree $ID"
Sleep 400ms
Enter
Sleep 4s
