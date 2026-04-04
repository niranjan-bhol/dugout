from PIL import Image

# Open the original image
image_path = "../raw/icons/mic (3).png" # Replace with your file name
img = Image.open(image_path)

# Resize the image to 48x48
resized_img = img.resize((48, 48))

# Save the new image
resized_img.save("microphone_icon_48x48.png")
print("Image resized successfully!")